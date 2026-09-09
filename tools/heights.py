# -*- coding: utf-8 -*-
"""건물 높이를 '추정' 대신 '실측'으로 바꾼다.

왜 필요한가
  OSM에는 높이가 붙은 건물이 적다(세 동네 평균 height 16% / 층수 23%).
  나머지는 바닥면적·용도로 추정하는데, 실제로 재 보니 평균오차가 18~43m였다.
  면적과 용도로는 높이를 맞힐 수 없다. 실측 데이터를 붙이는 수밖에 없다.

두 갈래로 채운다
  1) 브이월드(VWorld) 건물 레이어  — 위치로 바로 맞춘다. 주소가 없어도 된다. 커버리지가 넓다.
  2) 건축물대장(공공데이터포털)     — 가장 상세하지만 '지번'으로만 조회된다.
     OSM의 도로명주소 → juso.go.kr → 지번·법정동코드 → 건축물대장 순으로 타고 간다.
     주소 태그가 있는 건물(약 24%)만 가능하다.

키 넣는 곳:  data/keys.json   (git 에 올라가지 않는다)
    { "vworld": "...", "datago": "...", "juso": "..." }
  또는 환경변수 VWORLD_KEY / DATAGO_KEY / JUSO_KEY

사용법
  python tools/heights.py --probe                 키가 살아있는지, 어떤 레이어가 되는지 확인
  python tools/heights.py --place yangjae         그 동네 높이를 실측으로 채운다
  python tools/heights.py --place yangjae --report 채운 결과만 요약해서 보여준다
"""
import argparse
import json
import math
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geom as G          # noqa: E402
import config as CF       # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYS_PATH = os.path.join(ROOT, "data", "keys.json")
HEIGHTS_DIR = os.path.join(ROOT, "data", "heights")
PLACES_JSON = os.path.join(ROOT, "web", "data", "places.json")

UA = "yangjae-3d/1.0 (personal hobby project)"
FLOOR_H = 3.35
GROUND_FLOOR_H = 4.3

# 실제로 호출해 확인한 레이어 이름 (2026-09-09).
#   LT_C_SPBD        건물   — gro_flo_co(지상층수), buld_nm(건물명)
#   LP_PA_CBND_BUBUN 연속지적도 — pnu(19자리) = 건축물대장 조회 열쇠
VWORLD_BUILDING_LAYER = "LT_C_SPBD"
VWORLD_PARCEL_LAYER = "LP_PA_CBND_BUBUN"
VWORLD_LAYERS = [VWORLD_BUILDING_LAYER]
# 층수가 들어 있을 만한 속성 이름 후보(응답을 보고 자동으로 고른다)
FLOOR_KEYS = ["gro_flo_co", "grnd_flr_cnt", "grndflrcnt", "flr_cnt", "층수", "bldg_flr",
              "gro_flo", "groflo", "gfloor", "gro_flr_co"]
HEIGHT_KEYS = ["heit", "height", "bldg_hgt", "hght", "높이"]


# ─────────────────────────── 키 ───────────────────────────
def normalize_datago(k):
    """공공데이터포털은 인증키를 Encoding/Decoding 두 벌로 준다.
    화면에 보이는 건 대개 Encoding(%2F, %2B, %3D 가 섞여 있다).
    우리가 urlencode 로 다시 인코딩하므로, 들어온 게 Encoding 이면 먼저 풀어 준다.
    → 사용자가 어느 쪽을 넣든 그냥 동작한다."""
    if k and "%" in k:
        return urllib.parse.unquote(k)
    return k


def load_keys():
    keys = {}
    if os.path.exists(KEYS_PATH):
        try:
            with open(KEYS_PATH, encoding="utf-8") as f:
                keys = json.load(f)
        except Exception as e:
            print(f"[주의] data/keys.json 을 읽지 못했습니다: {e}")
    if keys.get("vworld_domain"):
        DOMAIN_CANDIDATES.insert(0, keys["vworld_domain"])
    for k, env in (("vworld", "VWORLD_KEY"), ("datago", "DATAGO_KEY"), ("juso", "JUSO_KEY")):
        if not keys.get(k) and os.environ.get(env):
            keys[k] = os.environ[env]
    keys = {k: v for k, v in keys.items() if v and not str(v).startswith("여기에")}
    if keys.get("datago"):
        keys["datago"] = normalize_datago(keys["datago"])
    return keys


def get(url, timeout=25, referer=None):
    # juso.go.kr 처럼 '등록한 URL에서 온 요청인지'를 보는 곳이 있다.
    # 파이썬에서 부르면 Referer 가 아예 없어서 거부될 수 있으므로 직접 붙여 준다.
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
        return r.read().decode("utf-8", "replace")


# ─────────────────────────── 브이월드 ───────────────────────────
# 브이월드는 키에 등록한 '서비스 URL' 과 요청의 domain 이 맞아야 한다.
# 사용자가 무엇으로 등록했는지 모를 수 있으므로 흔한 값들을 차례로 시도하고,
# 한 번 통한 값을 기억해서 그 뒤로는 그것만 쓴다.
DOMAIN_CANDIDATES = ["http://localhost:8765", "http://localhost", "localhost",
                     "http://127.0.0.1:8765", ""]
_good_domain = [None]


def vworld_fetch(key, layer, bbox, page=1, size=1000, domain=None):
    """bbox = (minLon, minLat, maxLon, maxLat)"""
    cands = [domain] if domain else ([_good_domain[0]] if _good_domain[0] is not None
                                     else DOMAIN_CANDIDATES)
    last = None
    for dm in cands:
        params = {
            "service": "data", "request": "GetFeature", "version": "2.0",
            "key": key, "data": layer, "format": "json", "size": str(size),
            "page": str(page), "crs": "EPSG:4326",
            "geomFilter": "BOX({},{},{},{})".format(*bbox),
        }
        if dm:
            params["domain"] = dm
        doc = json.loads(get("https://api.vworld.kr/req/data?" + urllib.parse.urlencode(params)))
        st, _ = vworld_status(doc)
        last = doc
        if st == "OK" or "NOT_APPLICABLE_KEY" not in json.dumps(doc):
            if st == "OK":
                _good_domain[0] = dm
            return doc
    return last


def vworld_features(doc):
    try:
        return doc["response"]["result"]["featureCollection"]["features"]
    except Exception:
        return []


def vworld_status(doc):
    try:
        return doc["response"]["status"], doc["response"].get("error", {}).get("text", "")
    except Exception:
        return "unknown", json.dumps(doc)[:200]


def pick_key(props, candidates):
    low = {k.lower(): k for k in props}
    for c in candidates:
        if c.lower() in low:
            return low[c.lower()]
    return None


def probe(keys):
    """키가 살아 있는지, 어떤 레이어·속성이 쓸 만한지 실제로 한 번 불러 본다."""
    ok = True
    if not keys.get("vworld"):
        print("  [브이월드] 키가 없습니다. data/keys.json 에 넣어 주세요.")
        ok = False
    else:
        # 서울시청 앞 아주 작은 상자 하나만 물어본다
        bbox = (126.9740, 37.5628, 126.9756, 37.5640)
        found = False
        for layer in VWORLD_LAYERS:
            try:
                doc = vworld_fetch(keys["vworld"], layer, bbox, size=5)
            except Exception as e:
                print(f"  [브이월드] {layer}: 요청 실패 {e}")
                continue
            st, msg = vworld_status(doc)
            fs = vworld_features(doc)
            if st == "OK" and fs:
                props = fs[0].get("properties", {})
                fk = pick_key(props, FLOOR_KEYS)
                hk = pick_key(props, HEIGHT_KEYS)
                print(f"  [브이월드] ✅ 레이어 '{layer}' 사용 가능 — {len(fs)}건 "
                      f"(domain='{_good_domain[0]}')")
                print(f"             층수 속성: {fk or '못 찾음'} / 높이 속성: {hk or '없음'}")
                print(f"             속성 목록: {sorted(props.keys())[:14]}")
                found = True
                break
            print(f"  [브이월드] {layer}: {st} {msg}")
        if not found:
            print("  [브이월드] 쓸 수 있는 건물 레이어를 못 찾았습니다. 위 메시지를 알려 주세요.")
            ok = False

    for name, k, test in (("juso.go.kr", "juso", None), ("공공데이터포털", "datago", None)):
        if not keys.get(k):
            print(f"  [{name}] 키가 없습니다.")
            ok = False
        else:
            print(f"  [{name}] 키가 들어 있습니다(실제 호출은 --place 로 확인).")
    return ok


def fetch_layer_all(key, layer, lat, lon, radius, say=print, steps=3, max_page=12):
    """반경 안의 레이어 도형을 전부 받아온다(BBOX 를 나눠서 + 페이징)."""
    dlat = radius / CF.M_PER_DEG_LAT
    dlon = radius / CF.M_PER_DEG_LON
    out = []
    for i in range(steps):
        for j in range(steps):
            bbox = (lon - dlon + 2 * dlon * i / steps, lat - dlat + 2 * dlat * j / steps,
                    lon - dlon + 2 * dlon * (i + 1) / steps, lat - dlat + 2 * dlat * (j + 1) / steps)
            for page in range(1, max_page + 1):
                try:
                    doc = vworld_fetch(key, layer, bbox, page=page)
                except Exception as e:
                    say("    %s 요청 실패: %s" % (layer, e))
                    break
                st, msg = vworld_status(doc)
                if st != "OK":
                    if page == 1 and st != "NOT_FOUND":
                        say("    %s: %s %s" % (layer, st, msg))
                    break
                fs = vworld_features(doc)
                out.extend(fs)
                if len(fs) < 1000:
                    break
                time.sleep(0.1)
    return out


def ring_of(f):
    """도형의 첫 번째 외곽선을 (lon,lat) 목록으로"""
    g = f.get("geometry") or {}
    t, cs = g.get("type"), g.get("coordinates")
    try:
        if t == "Polygon":
            return cs[0]
        if t == "MultiPolygon":
            return cs[0][0]
    except Exception:
        pass
    return None


def build_grid(items, cell=40.0):
    """[(값, 로컬링)] 목록을 격자에 담는다"""
    grid = {}
    for val, ring in items:
        x0, z0, x1, z1 = G.bbox(ring)
        for gx in range(int(x0 // cell), int(x1 // cell) + 1):
            for gz in range(int(z0 // cell), int(z1 // cell) + 1):
                grid.setdefault((gx, gz), []).append((val, ring))
    return grid, cell


def lookup(grid, cell, x, z):
    for val, ring in grid.get((int(x // cell), int(z // cell)), ()):
        if G.point_in_ring((x, z), ring):
            return val
    return None


def daejang_by_pnu(key, pnu):
    """PNU(19자리) → [높이, 출처]. 없으면 None."""
    q = {"serviceKey": key, "sigunguCd": pnu[0:5], "bjdongCd": pnu[5:10],
         "platGbCd": "0" if pnu[10] == "1" else "1",
         "bun": pnu[11:15], "ji": pnu[15:19],
         "numOfRows": "10", "pageNo": "1", "_type": "json"}
    url = ("https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?"
           + urllib.parse.urlencode(q))
    j = None
    for attempt in range(2):
        try:
            j = json.loads(get(url))
            break
        except Exception:
            if attempt == 1:
                return None
            time.sleep(0.6)
    if j is None:
        return None
    items = (((j.get("response") or {}).get("body") or {}).get("items") or {}).get("item")
    if not items:
        return None
    if isinstance(items, dict):
        items = [items]
    best_h, best_fl = 0.0, 0.0
    for it in items:
        try:
            h = float(it.get("heit") or 0)
        except Exception:
            h = 0.0
        try:
            fl = float(it.get("grndFlrCnt") or 0)
        except Exception:
            fl = 0.0
        if h > best_h:
            best_h = h
        if fl > best_fl:
            best_fl = fl
    if best_h > 2:
        return [round(best_h, 1), "건축물대장"]
    if best_fl >= 1:
        # 높이가 안 적힌 대장이 많다. 그럴 땐 층수로 환산한다(대장 층수는 실측이다).
        return [round(GROUND_FLOOR_H + (best_fl - 1) * FLOOR_H, 1), "건축물대장(층수)"]
    return None


def enrich(keys, place, buildings, say=print, limit=1500):
    """실측 높이표 {osm_id: [높이, 출처]} 를 만든다.

    우선순위:  건축물대장 높이 > 건축물대장 층수 > 브이월드 건물 층수
    (뒤에서 덮어쓰므로 정확한 것을 나중에 넣는다)
    """
    lat, lon, radius = place["lat"], place["lon"], place["radius"]
    CF.set_origin(lat, lon)
    out = {}
    key = keys.get("vworld")
    if not key:
        say("  브이월드 키가 없어 건너뜁니다.")
        return out

    centers = []
    for b in buildings:
        ring = [tuple(p) for p in b["poly"]]
        centers.append((b, G.centroid(ring)))

    # ── 1) 브이월드 건물 레이어: 위치로 층수 맞추기 ──
    say("  브이월드 건물 도형을 받는 중…")
    feats = fetch_layer_all(key, VWORLD_BUILDING_LAYER, lat, lon, radius, say)
    say("    건물 도형 %s건" % format(len(feats), ","))
    items = []
    for f in feats:
        r = ring_of(f)
        if not r:
            continue
        pr = f.get("properties") or {}
        try:
            fl = float(pr.get("gro_flo_co") or 0)
        except Exception:
            fl = 0
        if fl < 1:
            continue
        items.append((fl, [CF.to_local(c[1], c[0]) for c in r]))
    bgrid, bcell = build_grid(items)
    n1 = 0
    for b, c in centers:
        fl = lookup(bgrid, bcell, c[0], c[1])
        if fl:
            out[b["id"]] = [round(GROUND_FLOOR_H + (fl - 1) * FLOOR_H, 1), "브이월드"]
            n1 += 1
    say("    → %s동에 층수를 맞췄습니다." % format(n1, ","))

    # ── 2) 지적도로 PNU 얻기 ──
    if not keys.get("datago"):
        say("  공공데이터포털 키가 없어 건축물대장은 건너뜁니다.")
        return out
    say("  지적도(필지)를 받는 중…")
    pfeats = fetch_layer_all(key, VWORLD_PARCEL_LAYER, lat, lon, radius, say)
    say("    필지 %s건" % format(len(pfeats), ","))
    pitems = []
    for f in pfeats:
        r = ring_of(f)
        pnu = (f.get("properties") or {}).get("pnu")
        if not r or not pnu:
            continue
        pitems.append((pnu, [CF.to_local(c[1], c[0]) for c in r]))
    pgrid, pcell = build_grid(pitems)

    # ── 3) 건축물대장 (같은 필지는 한 번만 부른다) ──
    want = {}
    for b, c in centers:
        pnu = lookup(pgrid, pcell, c[0], c[1])
        if pnu:
            want.setdefault(pnu, []).append(b["id"])
    nb = sum(len(v) for v in want.values())
    say("  건축물대장 조회 대상 필지 %s곳 (건물 %s동)"
        % (format(len(want), ","), format(nb, ",")))
    n2 = 0
    todo = list(want.items())[:limit]
    if len(want) > limit:
        say("    ⚠ 일일 한도 때문에 %s곳만 조회합니다(--limit 로 조절)." % format(limit, ","))
    for i, (pnu, ids) in enumerate(todo):
        v = daejang_by_pnu(keys["datago"], pnu)
        time.sleep(0.05)
        if not v:
            continue
        for bid in ids:
            out[bid] = v
            n2 += 1
        if (i + 1) % 200 == 0:
            say("    %d/%d … %s동 확보" % (i + 1, len(todo), format(n2, ",")))
    say("    → 건축물대장으로 %s동을 채웠습니다." % format(n2, ","))
    return out


# ─────────────────────────── 실행 ───────────────────────────
def load_place(slug):
    with open(PLACES_JSON, encoding="utf-8") as f:
        d = json.load(f)
    for p in d.get("places", []):
        if p["slug"] == slug:
            return p
    raise SystemExit(f"[중단] '{slug}' 동네가 없습니다. tools/place.py --list 로 확인하세요.")


def read_buildings(slug):
    import glob
    out = []
    for f in glob.glob(os.path.join(ROOT, "web", "data", "places", slug, "chunks", "*.json")):
        with open(f, encoding="utf-8") as fh:
            out.extend(json.load(fh)["buildings"])
    return [b for b in out if not b.get("gen")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--place", default=None)
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--limit", type=int, default=1500,
                    help="건축물대장을 조회할 최대 필지 수(일일 한도 10,000)")
    args = ap.parse_args()

    keys = load_keys()
    if args.probe:
        print("[확인] 키와 데이터 접근을 시험합니다.")
        probe(keys)
        return

    slug = args.place
    if not slug:
        with open(PLACES_JSON, encoding="utf-8") as f:
            slug = json.load(f).get("default", "yangjae")
    pl = load_place(slug)
    os.makedirs(HEIGHTS_DIR, exist_ok=True)
    out_path = os.path.join(HEIGHTS_DIR, f"{slug}.json")

    if args.report:
        if not os.path.exists(out_path):
            print("아직 만든 것이 없습니다.")
            return
        with open(out_path, encoding="utf-8") as f:
            d = json.load(f)
        src = {}
        for v in d.get("heights", {}).values():
            src[v[1]] = src.get(v[1], 0) + 1
        print(f"[{pl['name']}] 실측 높이 {len(d.get('heights', {})):,}동")
        for k, v in src.items():
            print(f"   {k}: {v:,}동")
        return

    buildings = read_buildings(slug)
    print(f"[{pl['name']}] OSM 건물 {len(buildings):,}동")
    have = enrich(keys, pl, buildings, limit=args.limit)

    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"slug": slug, "name": pl["name"],
                   "madeAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "heights": have}, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    print(f"[저장] {len(have):,}동의 실측 높이 → {out_path}")
    print("       이제 [지도다시만들기.bat] 을 돌리면 반영됩니다.")


if __name__ == "__main__":
    main()
