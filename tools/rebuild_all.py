# -*- coding: utf-8 -*-
"""이미 받아 둔 OSM 원본으로 모든 동네의 지도를 다시 만든다.

높이 규칙이나 렌더링 데이터를 손봤을 때 쓴다. 인터넷을 쓰지 않으므로 빠르고,
Overpass 에 부담도 주지 않는다.

    python tools/rebuild_all.py            모든 동네
    python tools/rebuild_all.py yangjae    한 동네만
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import config as CF          # noqa: E402
import build_scene           # noqa: E402

PLACES = os.path.join(ROOT, "web", "data", "places.json")


def main():
    want = sys.argv[1:] or None
    with open(PLACES, encoding="utf-8") as f:
        places = json.load(f)["places"]

    for p in places:
        slug = p["slug"]
        if want and slug not in want:
            continue
        raw = os.path.join(ROOT, "data", "raw", slug, "osm_raw.json")
        if not os.path.exists(raw):
            print(f"[건너뜀] {p['name']}: 원본이 없습니다 ({raw})")
            continue
        out = os.path.join(ROOT, "web", "data", "places", slug)
        print(f"\n{'=' * 60}\n[{p['name']}] 다시 만드는 중…\n{'=' * 60}")
        CF.set_origin(p["lat"], p["lon"])
        build_scene.build(raw_path=raw, out_dir=out, radius=p.get("radius"))


if __name__ == "__main__":
    main()
