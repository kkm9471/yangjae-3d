# -*- coding: utf-8 -*-
"""OpenStreetMap Overpass API 에서 원본 데이터를 1회 수집한다.

설계 원칙
  1) Overpass 는 공개 무료 서버다. 남용하면 차단된다.
     → 받은 원본을 디스크에 저장하고, 이미 있으면 다시 받지 않는다(--force 로만 재수집).
  2) '조용한 실패' 방지: Overpass 는 타임아웃/메모리 초과 시에도 HTTP 200 으로
     '일부만' 돌려주면서 remark 필드에 사유를 적는다. 그걸 반드시 검사해서
     부분 데이터를 정상인 것처럼 저장하지 않는다.
  3) 미러 3곳 + 지수 백오프 재시도.

사용법:  python tools/fetch_osm.py           (이미 있으면 건너뜀)
         python tools/fetch_osm.py --force   (강제 재수집)
"""
import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config as CF  # noqa: E402  (동네를 바꿀 수 있게 모듈로 참조)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "data", "raw")
RAW_PATH = os.path.join(RAW_DIR, "osm_raw.json")
META_PATH = os.path.join(RAW_DIR, "osm_meta.json")


def paths_for(raw_dir):
    return os.path.join(raw_dir, "osm_raw.json"), os.path.join(raw_dir, "osm_meta.json")

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# 수집 대상. 하나라도 빠지면 화면에서 통째로 사라지는 요소들이므로
# 여기 목록이 곧 '무엇을 만들 수 있는가'의 상한선이다.
QUERY_TEMPLATE = """
[out:json][timeout:600];
(
  way["building"](around:{r},{lat},{lon});
  relation["building"]["type"="multipolygon"](around:{r},{lat},{lon});
  way["building:part"](around:{r},{lat},{lon});

  way["highway"](around:{r},{lat},{lon});
  way["railway"](around:{r},{lat},{lon});

  node["highway"~"^(crossing|traffic_signals|bus_stop|street_lamp|stop|give_way|elevator)$"](around:{r},{lat},{lon});
  node["railway"~"^(subway_entrance|station|tram_stop|level_crossing)$"](around:{r},{lat},{lon});
  node["public_transport"](around:{r},{lat},{lon});

  node["natural"="tree"](around:{r},{lat},{lon});
  way["natural"](around:{r},{lat},{lon});
  way["leisure"](around:{r},{lat},{lon});
  way["landuse"](around:{r},{lat},{lon});
  way["waterway"](around:{r},{lat},{lon});
  way["barrier"](around:{r},{lat},{lon});
  way["man_made"](around:{r},{lat},{lon});

  node["shop"](around:{r},{lat},{lon});
  node["amenity"](around:{r},{lat},{lon});
  node["office"](around:{r},{lat},{lon});
  node["tourism"](around:{r},{lat},{lon});
  node["leisure"](around:{r},{lat},{lon});
  node["healthcare"](around:{r},{lat},{lon});
  node["craft"](around:{r},{lat},{lon});
  node["advertising"](around:{r},{lat},{lon});
  node["man_made"](around:{r},{lat},{lon});

  way["shop"](around:{r},{lat},{lon});
  way["amenity"](around:{r},{lat},{lon});
  way["office"](around:{r},{lat},{lon});
  way["tourism"](around:{r},{lat},{lon});
);
out geom;
"""


def build_query(radius: int) -> str:
    return QUERY_TEMPLATE.format(r=radius, lat=CF.ORIGIN_LAT, lon=CF.ORIGIN_LON)


def post(url: str, query: str, timeout: int = 900) -> bytes:
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": "yangjae-3d/1.0 (personal study project; rudah9471@gmail.com)",
            "Accept-Encoding": "gzip",
        },
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            import gzip
            raw = gzip.decompress(raw)
        return raw


def fetch(radius: int) -> dict:
    query = build_query(radius)
    last_err = None
    for attempt in range(1, 7):
        mirror = MIRRORS[(attempt - 1) % len(MIRRORS)]
        print(f"  [{attempt}/6] {mirror} 요청 중... (반경 {radius}m)", flush=True)
        t0 = time.time()
        try:
            raw = post(mirror, query)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
            wait = min(60, 5 * 2 ** (attempt - 1))
            print(f"      실패: {e} → {wait}초 후 재시도", flush=True)
            time.sleep(wait)
            continue

        dt = time.time() - t0
        print(f"      응답 {len(raw)/1048576:.1f} MB / {dt:.0f}초", flush=True)
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception as e:
            last_err = e
            print(f"      JSON 파싱 실패: {e}", flush=True)
            time.sleep(10)
            continue

        # ── 조용한 실패 검사 ──
        remark = doc.get("remark")
        if remark:
            print(f"      ! Overpass remark: {remark}", flush=True)
            if any(k in remark.lower() for k in ("timeout", "memory", "exceeded", "error")):
                last_err = RuntimeError(f"Overpass 부분응답: {remark}")
                time.sleep(20)
                continue
        return doc

    raise SystemExit(f"[중단] Overpass 수집 실패: {last_err}")


def summarize(doc: dict) -> dict:
    els = doc.get("elements", [])
    counts = {"total": len(els), "node": 0, "way": 0, "relation": 0}
    tagcount = {}
    for e in els:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
        t = e.get("tags", {})
        for key in ("building", "highway", "shop", "amenity", "natural", "railway",
                    "leisure", "landuse", "office", "man_made", "public_transport"):
            if key in t:
                tagcount[key] = tagcount.get(key, 0) + 1
    counts["by_tag"] = tagcount
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="이미 받은 원본이 있어도 다시 받는다")
    ap.add_argument("--radius", type=int, default=None)
    ap.add_argument("--dir", default=None, help="원본을 저장할 폴더")
    ap.add_argument("--lat", type=float, default=None, help="중심 위도")
    ap.add_argument("--lon", type=float, default=None, help="중심 경도")
    args = ap.parse_args()
    global RAW_DIR, RAW_PATH, META_PATH
    if args.lat is not None and args.lon is not None:
        CF.set_origin(args.lat, args.lon)
    if args.dir:
        RAW_DIR = args.dir
        RAW_PATH, META_PATH = paths_for(RAW_DIR)
    if args.radius is None:
        args.radius = CF.RAW_RADIUS_M

    os.makedirs(RAW_DIR, exist_ok=True)

    if os.path.exists(RAW_PATH) and not args.force:
        meta = {}
        if os.path.exists(META_PATH):
            with open(META_PATH, encoding="utf-8") as f:
                meta = json.load(f)
        have = meta.get("radius_m", 0)
        if have >= args.radius:
            print(f"[건너뜀] 이미 반경 {have}m 원본이 있습니다 → {RAW_PATH}")
            print(f"         요소 {meta.get('counts',{}).get('total','?')}개, 수집일 {meta.get('fetched_at','?')}")
            print("         다시 받으려면: python tools/fetch_osm.py --force")
            return
        print(f"[재수집] 기존 반경 {have}m < 요청 {args.radius}m")

    print(f"[수집] ({CF.ORIGIN_LAT:.6f}, {CF.ORIGIN_LON:.6f}) 반경 {args.radius}m")
    doc = fetch(args.radius)
    counts = summarize(doc)

    # ── 최소 건전성 검사: 이 정도도 안 나오면 뭔가 잘못된 것 ──
    problems = []
    if counts["total"] < 3000:
        problems.append(f"요소 총 {counts['total']}개 — 반경 {args.radius}m 치고 적음(시골이면 정상일 수 있음)")
    if counts["by_tag"].get("building", 0) < 300:
        problems.append(f"건물 {counts['by_tag'].get('building',0)}개 — 너무 적음")
    if counts["by_tag"].get("highway", 0) < 200:
        problems.append(f"도로/보행요소 {counts['by_tag'].get('highway',0)}개 — 너무 적음")
    if problems:
        print("\n[경고] 수집 결과가 의심스럽습니다:")
        for p in problems:
            print("   -", p)
        print("  그래도 저장은 합니다. 화면이 휑하면 이 경고를 먼저 의심하세요.\n")

    with open(RAW_PATH, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    meta = {
        "origin": {"lat": CF.ORIGIN_LAT, "lon": CF.ORIGIN_LON},
        "radius_m": args.radius,
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "osm_timestamp": doc.get("osm3s", {}).get("timestamp_osm_base"),
        "counts": counts,
        "license": "© OpenStreetMap contributors (ODbL)",
    }
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    size = os.path.getsize(RAW_PATH) / 1048576
    print(f"\n[완료] {RAW_PATH}  ({size:.1f} MB)")
    print(f"  총 {counts['total']:,}개 (node {counts['node']:,} / way {counts['way']:,} / relation {counts['relation']:,})")
    for k, v in sorted(counts["by_tag"].items(), key=lambda x: -x[1]):
        print(f"    {k:16s} {v:,}")


if __name__ == "__main__":
    main()
