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

# 브이월드 건물 레이어 후보. 계정마다 열려 있는 것이 달라서 순서대로 시험한다.
VWORLD_LAYERS = ["LT_C_BLDINFO", "LT_C_SPBD_BULD", "LT_C_BULD", "LT_C_UPISUQ151"]
# 층수가 들어 있을 만한 속성 이름 후보(응답을 보고 자동으로 고른다)
FLOOR_KEYS = ["gro_flo_co", "grnd_flr_cnt", "grndflrcnt", "flr_cnt", "층수", "bldg_flr",
              "gro_flo", "groflo", "gfloor", "gro_flr_co"]
HEIGHT_KEYS = ["heit", "height", "bldg_hgt", "hght", "높이"]


# ─────────────────────────── 키 ───────────────────────────
def load_keys():
    keys = {}
    if os.path.exists(KEYS_PATH):
        try:
            with open(KEYS_PATH, encoding="utf-8") as f:
                keys = json.load(f)
        except Exception as e:
            print(f"[주의] data/keys.json 을 읽지 못했습니다: {e}")
    for k, env in (("vworld", "VWORLD_KEY"), ("datago", "DATAGO_KEY"), ("juso", "JUSO_KEY")):
        if not keys.get(k) and os.environ.get(env):
            keys[k] = os.environ[env]
    return {k: v for k, v in keys.items() if v and not str(v).startswith("여기에")}


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
        return r.read().decode("utf-8", "replace")


# ─────────────────────────── 브이월드 ───────────────────────────
def vworld_fetch(key, layer, bbox, page=1, size=1000):
    """bbox = (minLon, minLat, maxLon, maxLat)"""
    url = "https://api.vworld.kr/req/data?" + urllib.parse.urlencode({
        "service": "data", "request": "GetFeature", "version": "2.0",
        "key": key, "data": layer, "format": "json", "size": str(size),
        "page": str(page), "crs": "EPSG:4326", "domain": "http://localhost",
        "geomFilter": "BOX({},{},{},{})".format(*bbox),
    })
    return json.loads(get(url))


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
                print(f"  [브이월드] ✅ 레이어 '{layer}' 사용 가능 — {len(fs)}건")
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


def enrich_vworld(key, lat, lon, radius, buildings, say=print):
    """위치로 바로 맞춘다. {osm_id: (높이, '브이월드')} 를 돌려준다."""
    CF.set_origin(lat, lon)
    # 반경을 위경도 상자로
    dlat = radius / CF.M_PER_DEG_LAT
    dlon = radius / CF.M_PER_DEG_LON

    # 건물 폴리곤을 격자에 넣어 두고, 브이월드 건물 중심점이 어느 건물 안인지 찾는다
    grid, cell = {}, 40.0
    for b in buildings:
        ring = [tuple(p) for p in b["poly"]]
        x0, z0, x1, z1 = G.bbox(ring)
        for gx in range(int(x0 // cell), int(x1 // cell) + 1):
            for gz in range(int(z0 // cell), int(z1 // cell) + 1):
                grid.setdefault((gx, gz), []).append((b, ring))

    layer = None
    out, tried, matched = {}, 0, 0
    # 1km 를 3×3 상자로 나눠 요청한다(한 번에 다 달라고 하면 잘린다)
    steps = 3
    for i in range(steps):
        for j in range(steps):
            bbox = (lon - dlon + 2 * dlon * i / steps, lat - dlat + 2 * dlat * j / steps,
                    lon - dlon + 2 * dlon * (i + 1) / steps, lat - dlat + 2 * dlat * (j + 1) / steps)
            page = 1
            while page <= 5:
                doc = None
                for cand in ([layer] if layer else VWORLD_LAYERS):
                    try:
                        d = vworld_fetch(key, cand, bbox, page=page)
                    except Exception as e:
                        say(f"    요청 실패: {e}")
                        continue
                    st, msg = vworld_status(d)
                    if st == "OK":
                        layer = cand
                        doc = d
                        break
                    if page == 1 and not layer:
                        say(f"    {cand}: {st} {msg}")
                if doc is None:
                    break
                fs = vworld_features(doc)
                if not fs:
                    break
                for f in fs:
                    tried += 1
                    props = f.get("properties", {}) or {}
                    fk = pick_key(props, FLOOR_KEYS)
                    hk = pick_key(props, HEIGHT_KEYS)
                    h = None
                    try:
                        if hk and float(props[hk]) > 2:
                            h = float(props[hk])
                    except Exception:
                        pass
                    if h is None and fk:
                        try:
                            fl = float(props[fk])
                            if 1 <= fl <= 130:
                                h = GROUND_FLOOR_H + (fl - 1) * FLOOR_H
                        except Exception:
                            pass
                    if h is None:
                        continue
                    c = feature_centroid(f)
                    if c is None:
                        continue
                    x, z = CF.to_local(c[1], c[0])
                    for b, ring in grid.get((int(x // cell), int(z // cell)), ()):
                        if G.point_in_ring((x, z), ring):
                            out[b["id"]] = (round(h, 1), "브이월드")
                            matched += 1
                            break
                if len(fs) < 1000:
                    break
                page += 1
                time.sleep(0.15)
    say(f"  브이월드 건물 {tried:,}건 중 {matched:,}건을 우리 건물에 맞췄습니다.")
    return out


def feature_centroid(f):
    g = f.get("geometry") or {}
    t = g.get("type")
    cs = g.get("coordinates")
    try:
        if t == "Polygon":
            ring = cs[0]
        elif t == "MultiPolygon":
            ring = cs[0][0]
        elif t == "Point":
            return (cs[0], cs[1])
        else:
            return None
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return (sum(xs) / len(xs), sum(ys) / len(ys))
    except Exception:
        return None


# ─────────────────────────── 건축물대장 ───────────────────────────
def juso_lookup(key, addr):
    """도로명주소 → 법정동코드·본번·부번"""
    url = "https://business.juso.go.kr/addrlink/addrLinkApi.do?" + urllib.parse.urlencode({
        "confmKey": key, "currentPage": "1", "countPerPage": "1",
        "keyword": addr, "resultType": "json",
    })
    d = json.loads(get(url))
    res = d.get("results", {})
    if (res.get("common", {}).get("errorCode") or "0") != "0":
        return None
    j = (res.get("juso") or [None])[0]
    if not j:
        return None
    adm = j.get("admCd") or ""
    if len(adm) < 10:
        return None
    return {"sigungu": adm[:5], "bjdong": adm[5:10],
            "bun": (j.get("lnbrMnnm") or "0"), "ji": (j.get("lnbrSlno") or "0")}


def daejang_floors(key, loc):
    """건축물대장 표제부에서 지상층수·높이"""
    url = "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?" + urllib.parse.urlencode({
        "serviceKey": key, "sigunguCd": loc["sigungu"], "bjdongCd": loc["bjdong"],
        "platGbCd": "0", "bun": str(loc["bun"]).zfill(4), "ji": str(loc["ji"]).zfill(4),
        "numOfRows": "5", "pageNo": "1", "_type": "json",
    })
    d = json.loads(get(url))
    items = (((d.get("response") or {}).get("body") or {}).get("items") or {}).get("item")
    if not items:
        return None
    if isinstance(items, dict):
        items = [items]
    best = None
    for it in items:
        try:
            h = float(it.get("heit") or 0)
        except Exception:
            h = 0
        try:
            fl = float(it.get("grndFlrCnt") or 0)
        except Exception:
            fl = 0
        cand = h if h > 2 else (GROUND_FLOOR_H + (fl - 1) * FLOOR_H if fl >= 1 else 0)
        if cand > (best or 0):
            best = cand
    return round(best, 1) if best else None


def enrich_daejang(keys, raw_path, buildings, have, say=print, limit=400):
    """주소 태그가 있는 건물만 대장으로 채운다(호출 수가 많아 한도가 있다)."""
    if not (keys.get("juso") and keys.get("datago")):
        say("  건축물대장: juso/datago 키가 없어 건너뜁니다.")
        return {}
    with open(raw_path, encoding="utf-8") as f:
        els = json.load(f)["elements"]
    addr_of = {}
    for e in els:
        t = e.get("tags") or {}
        if "building" not in t:
            continue
        st, hn = t.get("addr:street"), t.get("addr:housenumber")
        if not (st and hn):
            continue
        city = t.get("addr:city") or ""
        dist = t.get("addr:district") or ""
        addr_of[f"{e['type'][0]}{e['id']}"] = " ".join(x for x in (city, dist, st, hn) if x)

    todo = [b for b in buildings if b["id"] in addr_of and b["id"] not in have][:limit]
    say(f"  건축물대장: 주소가 있고 아직 안 채워진 건물 {len(todo)}동을 조회합니다 "
        f"(전체 주소 보유 {len(addr_of)}동)")
    out = {}
    for i, b in enumerate(todo):
        try:
            loc = juso_lookup(keys["juso"], addr_of[b["id"]])
            if not loc:
                continue
            h = daejang_floors(keys["datago"], loc)
            if h and 2 < h < 400:
                out[b["id"]] = (h, "건축물대장")
        except Exception as e:
            if i < 3:
                say(f"    조회 실패({addr_of[b['id']]}): {e}")
        time.sleep(0.12)          # 공공 API 예의
        if (i + 1) % 50 == 0:
            say(f"    {i+1}/{len(todo)} … {len(out)}건 확보")
    say(f"  건축물대장에서 {len(out)}건 확보")
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
    ap.add_argument("--limit", type=int, default=400)
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
    have = {}
    if keys.get("vworld"):
        have.update(enrich_vworld(keys["vworld"], pl["lat"], pl["lon"], pl["radius"], buildings))
    else:
        print("  브이월드 키가 없어 건너뜁니다.")
    have.update(enrich_daejang(keys, os.path.join(ROOT, "data", "raw", slug, "osm_raw.json"),
                               buildings, have, limit=args.limit))

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
