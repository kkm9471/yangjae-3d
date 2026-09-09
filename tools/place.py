# -*- coding: utf-8 -*-
"""동네 하나를 통째로 만든다: 주소 → 좌표 → OSM 수집 → 3D 청크.

  python tools/place.py "서울 시청"
  python tools/place.py --lat 37.5665 --lon 126.9780 --name "서울시청"
  python tools/place.py --list

주소→좌표 변환은 OpenStreetMap 공식 지오코더 Nominatim 을 쓴다(무료, 키 불필요).
  https://nominatim.org/release-docs/latest/api/Search/
공개 서버라 규칙이 있다: 초당 1건 이하, 연락처가 담긴 User-Agent 필수.
지오코딩 결과는 캐시해서 같은 주소를 두 번 묻지 않는다.
"""
import argparse
import json
import os
import shutil
import ssl
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config as CF          # noqa: E402
import fetch_osm             # noqa: E402
import build_scene           # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLACES_DIR = os.path.join(ROOT, "web", "data", "places")
PLACES_JSON = os.path.join(ROOT, "web", "data", "places.json")
RAW_ROOT = os.path.join(ROOT, "data", "raw")
GEO_CACHE = os.path.join(RAW_ROOT, "geocode_cache.json")

UA = "yangjae-3d/1.0 (personal hobby project; contact via github)"
_last_geo = [0.0]


# ─────────────────────────── 주소 → 좌표 ───────────────────────────
def _cache():
    try:
        with open(GEO_CACHE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(c):
    os.makedirs(RAW_ROOT, exist_ok=True)
    tmp = GEO_CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(c, f, ensure_ascii=False, indent=1)
    os.replace(tmp, GEO_CACHE)


def geocode(q, limit=5):
    """주소·장소 이름 → [{name, lat, lon, kind}, ...]  (가까운 순이 아니라 관련도 순)"""
    q = (q or "").strip()
    if not q:
        return []
    cache = _cache()
    if q in cache:
        return cache[q]

    # 공개 서버 예의: 요청 간 1초 이상
    wait = 1.05 - (time.time() - _last_geo[0])
    if wait > 0:
        time.sleep(wait)
    _last_geo[0] = time.time()

    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
        "q": q, "format": "jsonv2", "limit": str(limit),
        "accept-language": "ko", "addressdetails": "0",
    })
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25, context=ssl.create_default_context()) as r:
        rows = json.loads(r.read().decode("utf-8"))

    out = []
    for row in rows:
        try:
            out.append({
                "name": row.get("display_name", q).split(",")[0].strip() or q,
                "full": row.get("display_name", ""),
                "lat": float(row["lat"]),
                "lon": float(row["lon"]),
                "kind": row.get("type", ""),
            })
        except Exception:
            continue
    cache[q] = out
    _save_cache(cache)
    return out


# ─────────────────────────── 동네 목록 ───────────────────────────
def slug_for(lat, lon):
    """같은 자리를 두 번 만들지 않도록, 좌표에서 바로 이름을 뽑는다(약 10m 단위)."""
    return f"p{int(round(lat * 10000))}_{int(round(lon * 10000))}"


def load_places():
    try:
        with open(PLACES_JSON, encoding="utf-8") as f:
            d = json.load(f)
            d.setdefault("places", [])
            d.setdefault("default", CF.DEFAULT_SLUG)
            return d
    except Exception:
        return {"default": CF.DEFAULT_SLUG, "places": []}


def save_places(d):
    os.makedirs(os.path.dirname(PLACES_JSON), exist_ok=True)
    tmp = PLACES_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PLACES_JSON)


def register(slug, name, lat, lon, radius, totals=None):
    d = load_places()
    rec = {"slug": slug, "name": name, "lat": round(lat, 6), "lon": round(lon, 6),
           "radius": radius, "builtAt": time.strftime("%Y-%m-%d %H:%M:%S")}
    if totals:
        rec["buildings"] = totals.get("buildings", 0)
        rec["roads"] = totals.get("roads", 0)
    d["places"] = [p for p in d["places"] if p["slug"] != slug] + [rec]
    d["places"].sort(key=lambda p: p["name"])
    save_places(d)
    return rec


# ─────────────────────────── 만들기 ───────────────────────────
def build_place(query=None, lat=None, lon=None, name=None, radius=None,
                force=False, progress=None):
    """주소나 좌표 하나로 동네 전체를 만든다."""
    radius = radius or CF.RAW_RADIUS_M
    say = progress or (lambda *a: None)

    if lat is None or lon is None:
        say("주소를 찾는 중…")
        hits = geocode(query)
        if not hits:
            raise ValueError(f"'{query}' 를 찾지 못했습니다. 더 자세히 적어 보세요 "
                             f"(예: '서울 강남구 역삼동', '부산 해운대역').")
        top = hits[0]
        lat, lon = top["lat"], top["lon"]
        name = name or top["name"]
        say(f"찾았습니다: {name} ({lat:.5f}, {lon:.5f})")
    name = name or f"{lat:.4f}, {lon:.4f}"

    # 이미 만들어 둔 동네와 20m 안이면 그 폴더를 그대로 쓴다
    # (같은 곳을 슬러그만 달리해 두 번 만들지 않기 위해)
    slug = slug_for(lat, lon)
    for pl in load_places()["places"]:
        if abs(pl["lat"] - lat) < 2e-4 and abs(pl["lon"] - lon) < 2.5e-4:
            slug = pl["slug"]
            name = name or pl["name"]
            break
    raw_dir = os.path.join(RAW_ROOT, slug)
    out_dir = os.path.join(PLACES_DIR, slug)
    raw_path, meta_path = fetch_osm.paths_for(raw_dir)

    # 원점을 옮긴다. 이 뒤로 to_local/to_latlon 이 이 동네 기준이 된다.
    CF.set_origin(lat, lon)

    # ── 1. 지도 원본 받기 ──
    if force or not os.path.exists(raw_path):
        say("OpenStreetMap 에서 지도를 받는 중… (10초쯤)")
        os.makedirs(raw_dir, exist_ok=True)
        doc = fetch_osm.fetch(radius)
        counts = fetch_osm.summarize(doc)
        tmp = raw_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
        os.replace(tmp, raw_path)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump({"origin": {"lat": lat, "lon": lon}, "radius_m": radius,
                       "name": name, "counts": counts,
                       "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                       "license": "© OpenStreetMap contributors (ODbL)"},
                      f, ensure_ascii=False, indent=1)
        nb = counts["by_tag"].get("building", 0)
        say(f"건물 {nb:,}동 · 도로 {counts['by_tag'].get('highway', 0):,}개를 받았습니다.")
        if nb < 40:
            say("⚠ 이 동네는 OpenStreetMap 에 등록된 건물이 아주 적습니다. "
                "화면 대부분이 '생성 건물'이 됩니다.")
    else:
        say("이미 받아 둔 지도를 씁니다.")

    # ── 2. 3D 로 만들기 ──
    say("건물과 도로를 3D 로 만드는 중…")
    os.makedirs(out_dir, exist_ok=True)
    index = build_scene.build(raw_path=raw_path, out_dir=out_dir, radius=radius)
    index_totals = (index or {}).get("totals", {})

    rec = register(slug, name, lat, lon, radius, index_totals)
    say(f"완료: {name} — 건물 {index_totals.get('buildings', 0):,}동")
    return rec


def migrate_default():
    """예전 구조(web/data/index.json)를 places/yangjae/ 로 옮긴다. 한 번만 실행된다."""
    old_index = os.path.join(ROOT, "web", "data", "index.json")
    old_chunks = os.path.join(ROOT, "web", "data", "chunks")
    new_dir = os.path.join(PLACES_DIR, CF.DEFAULT_SLUG)
    if not os.path.exists(old_index):
        return False
    os.makedirs(new_dir, exist_ok=True)
    shutil.move(old_index, os.path.join(new_dir, "index.json"))
    if os.path.isdir(old_chunks):
        dst = os.path.join(new_dir, "chunks")
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        shutil.move(old_chunks, dst)
    # 원본도 슬러그 폴더로
    old_raw = os.path.join(RAW_ROOT, "osm_raw.json")
    if os.path.exists(old_raw):
        d = os.path.join(RAW_ROOT, CF.DEFAULT_SLUG)
        os.makedirs(d, exist_ok=True)
        for f in ("osm_raw.json", "osm_meta.json"):
            src = os.path.join(RAW_ROOT, f)
            if os.path.exists(src):
                shutil.move(src, os.path.join(d, f))
    register(CF.DEFAULT_SLUG, CF.DEFAULT_NAME, CF.DEFAULT_LAT, CF.DEFAULT_LON, CF.RAW_RADIUS_M)
    d = load_places()
    d["default"] = CF.DEFAULT_SLUG
    save_places(d)
    print(f"[이동] 기존 양재역 지도를 {new_dir} 로 옮겼습니다.")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?", help="주소나 장소 이름")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--name")
    ap.add_argument("--radius", type=int, default=None)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true", help="만들어 둔 동네 목록")
    ap.add_argument("--migrate", action="store_true", help="예전 구조를 places/ 로 이동")
    args = ap.parse_args()

    if args.migrate:
        if not migrate_default():
            print("옮길 것이 없습니다(이미 옮겼거나 처음 실행).")
        return
    if args.list:
        d = load_places()
        print(f"기본 동네: {d['default']}")
        for p in d["places"]:
            print(f"  {p['slug']:20s} {p['name']}  ({p['lat']}, {p['lon']})  반경 {p['radius']}m")
        return
    if not args.query and args.lat is None:
        ap.error("주소를 적거나 --lat/--lon 을 주세요.")
    build_place(args.query, args.lat, args.lon, args.name, args.radius,
                args.force, progress=lambda m: print("  " + m, flush=True))


if __name__ == "__main__":
    main()
