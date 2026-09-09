# -*- coding: utf-8 -*-
"""추정 높이가 실제로 얼마나 틀렸는지 숫자로 보여 준다.

지금 지도에 들어 있는 높이(= OSM 태그 또는 추정)와
브이월드·건축물대장에서 받아온 실측 높이를 같은 건물끼리 맞대어 본다.

사용법: python tests/height_report.py [--place yangjae]
"""
import argparse
import glob
import json
import os
import statistics
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLACES = os.path.join(ROOT, "web", "data", "places.json")


def load(slug):
    bs = []
    for f in glob.glob(os.path.join(ROOT, "web", "data", "places", slug, "chunks", "*.json")):
        with open(f, encoding="utf-8") as fh:
            bs.extend(json.load(fh)["buildings"])
    hp = os.path.join(ROOT, "data", "heights", f"{slug}.json")
    real = {}
    if os.path.exists(hp):
        with open(hp, encoding="utf-8") as fh:
            real = json.load(fh).get("heights") or {}
    return bs, real


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--place", default=None)
    args = ap.parse_args()

    with open(PLACES, encoding="utf-8") as f:
        pj = json.load(f)
    slugs = [args.place] if args.place else [p["slug"] for p in pj["places"]]
    names = {p["slug"]: p["name"] for p in pj["places"]}

    for slug in slugs:
        bs, real = load(slug)
        osm = [b for b in bs if not b.get("gen")]
        if not real:
            print(f"[{names.get(slug, slug)}] 실측 높이 파일이 없습니다. "
                  f"tools/heights.py --place {slug} 를 먼저 돌리세요.\n")
            continue

        src = {}
        for v in real.values():
            src[v[1]] = src.get(v[1], 0) + 1

        # 지금 지도에 들어 있는 높이와 비교
        diffs, big = [], []
        for b in osm:
            r = real.get(b["id"])
            if not r:
                continue
            d = abs(b["h"] - float(r[0]))
            diffs.append(d)
            if d > 20:
                big.append((d, b.get("name") or "(무명)", b["h"], float(r[0])))

        cov = len(diffs) / max(1, len(osm)) * 100
        print("=" * 66)
        print(f"  [{names.get(slug, slug)}]  OSM 건물 {len(osm):,}동")
        print(f"  실측 확보 {len(real):,}동 · 지금 지도와 맞대어 본 것 {len(diffs):,}동 ({cov:.0f}%)")
        for k, v in sorted(src.items(), key=lambda x: -x[1]):
            print(f"     {k:16s} {v:,}동")
        if diffs:
            diffs.sort()
            print(f"  지금 높이와 실측의 차이:  평균 {statistics.mean(diffs):5.1f}m"
                  f" · 중앙값 {statistics.median(diffs):5.1f}m"
                  f" · 20m 넘게 틀린 건물 {sum(1 for d in diffs if d > 20):,}동")
            big.sort(reverse=True)
            if big:
                print("  많이 틀렸던 건물:")
                for d, nm, old, new in big[:6]:
                    print(f"     {nm[:22]:24s} {old:6.1f}m → {new:6.1f}m   ({d:5.1f}m 차이)")
        print()


if __name__ == "__main__":
    sys.exit(main())
