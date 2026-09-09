# -*- coding: utf-8 -*-
"""높이를 '지어낸 값'에서 '실제 값'으로 바꾼 효과를 숫자로 보여 준다.

세 가지를 답한다.
  1. 지금 지도의 높이는 어디서 왔나 (실측 몇 %)
  2. 예전처럼 추정만 했다면 실제와 몇 m 틀렸을까
  3. 어떤 건물이 가장 크게 바뀌었나

사용법: python tests/height_report.py [--place yangjae] [--all]
"""
import argparse
import glob
import json
import os
import statistics
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import config as CF          # noqa: E402
import build_scene as BS     # noqa: E402
import geom as G             # noqa: E402

PLACES = os.path.join(ROOT, "web", "data", "places.json")


def chunk_heights(slug):
    """지금 지도에 들어 있는 높이 {id: h}"""
    out = {}
    for f in glob.glob(os.path.join(ROOT, "web", "data", "places", slug, "chunks", "*.json")):
        with open(f, encoding="utf-8") as fh:
            for b in json.load(fh)["buildings"]:
                if not b.get("gen"):
                    out[b["id"]] = (b["h"], b.get("name") or "", b.get("area", 0))
    return out


def guessed_heights(slug, place):
    """실측을 몰랐을 때 우리가 지어냈을 높이 {id: (h, 근거)}"""
    raw = os.path.join(ROOT, "data", "raw", slug, "osm_raw.json")
    if not os.path.exists(raw):
        return {}
    CF.set_origin(place["lat"], place["lon"])
    out = {}
    for e in BS.load(raw):
        t = e.get("tags") or {}
        if "building" not in t or t.get("building") == "no":
            continue
        for ri, (outer, _holes) in enumerate(BS.rings_from_element(e)):
            a = G.area(outer)
            if a < 8:
                continue
            seed = BS.h32(e["id"], 1 + ri * 977)
            bid = f"{e['type'][0]}{e['id']}" if ri == 0 else f"{e['type'][0]}{e['id']}#{ri}"
            out[bid] = BS.parse_height(t, a, seed)
    return out


def measured(slug):
    p = os.path.join(ROOT, "data", "heights", f"{slug}.json")
    if not os.path.exists(p):
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f).get("heights") or {}


def report(slug, name):
    now = chunk_heights(slug)
    real = measured(slug)
    if not now:
        print(f"[{name}] 지도가 아직 없습니다.\n")
        return
    print("=" * 68)
    print(f"  [{name}]   OSM 건물 {len(now):,}동")
    print("=" * 68)
    if not real:
        print(f"  실측 높이 파일이 없습니다."
              f"  → python tools/heights.py --place {slug}\n")
        return

    src = {}
    for v in real.values():
        src[v[1]] = src.get(v[1], 0) + 1
    hit = sum(1 for bid in now if bid in real)
    print(f"  1) 실측 높이를 확보한 건물 {hit:,}동 ({hit * 100 // len(now)}%)")
    for k, v in sorted(src.items(), key=lambda x: -x[1]):
        print(f"       {k:22s} {v:,}동")

    # 2) 추정만 했다면 얼마나 틀렸을까
    #    OSM 태그조차 없어서 순수하게 지어냈던 건물만 본다(그게 진짜 '추정'이다).
    guess = guessed_heights(slug, PL[slug])
    errs, worst = [], []
    for bid, (gh, how) in guess.items():
        if how != "추정" or bid not in real or bid not in now:
            continue
        rh = float(real[bid][0])
        errs.append(abs(gh - rh))
        worst.append((abs(gh - rh), now[bid][1] or "(무명)", gh, rh))
    if errs:
        errs.sort()
        print(f"\n  2) 예전 '추정' 방식이 실제와 얼마나 달랐나 (순수 추정 {len(errs):,}동 기준)")
        print(f"       평균 {statistics.mean(errs):.1f}m 어긋남"
              f" · 중앙값 {statistics.median(errs):.1f}m"
              f" · 10m 넘게 틀린 것 {sum(1 for d in errs if d > 10) * 100 // len(errs)}%")
    else:
        print("\n  2) 순수 추정으로 남은 건물이 없습니다(전부 태그나 실측이 있음).")

    # 3) 가장 크게 바뀐 건물
    worst.sort(reverse=True)
    if worst:
        print("\n  3) 추정과 가장 크게 달랐던 건물")
        for d, nm, gh, rh in worst[:8]:
            print(f"       {nm[:22]:24s} 추정 {gh:5.1f}m  →  실제 {rh:5.1f}m   ({d:.0f}m 차이)")

    # 스카이라인이 어떻게 달라졌나
    hs = sorted((v[0] for v in now.values()), reverse=True)
    print(f"\n     지금 지도의 스카이라인: 가장 높은 건물 {hs[0]:.0f}m ·"
          f" 상위 10동 평균 {statistics.mean(hs[:10]):.0f}m ·"
          f" 전체 평균 {statistics.mean(hs):.0f}m")
    print()


PL = {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--place", default=None)
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    with open(PLACES, encoding="utf-8") as f:
        pj = json.load(f)
    for p in pj["places"]:
        PL[p["slug"]] = p
    if args.place:
        slugs = [args.place]
    elif args.all:
        slugs = [p["slug"] for p in pj["places"]]
    else:
        slugs = [pj["default"]]
    for s in slugs:
        report(s, PL.get(s, {}).get("name", s))


if __name__ == "__main__":
    sys.exit(main())
