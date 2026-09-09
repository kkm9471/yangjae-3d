# -*- coding: utf-8 -*-
"""데이터가 조용히 망가졌는지 기계적으로 검사한다.

'화면이 그럴듯하다'는 검증이 아니다. 눈으로는 절대 못 잡는 것들 —
좌표가 미묘하게 어긋났는지, 도로를 청크로 자르면서 길이가 사라졌는지,
간판이 엉뚱한 건물에 붙었는지 — 을 숫자로 확인한다.

사용법: python tests/verify.py
반환값: 문제가 하나라도 있으면 1
"""
import glob
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import geom as G                                      # noqa: E402
from config import (ORIGIN_LAT, ORIGIN_LON, CHUNK_SIZE_M,   # noqa: E402
                    M_PER_DEG_LAT, M_PER_DEG_LON, to_local, to_latlon)

FAIL = []
WARN = []
OK = []


def check(name, cond, detail=""):
    (OK if cond else FAIL).append(f"{name}{(' — ' + detail) if detail else ''}")
    return cond


def warn(name, cond, detail=""):
    if not cond:
        WARN.append(f"{name}{(' — ' + detail) if detail else ''}")
    else:
        OK.append(name)


def main():
    idx_path = os.path.join(ROOT, "web", "data", "index.json")
    if not os.path.exists(idx_path):
        print("[중단] web/data/index.json 이 없습니다. 먼저 build_scene.py 를 돌리세요.")
        return 1
    with open(idx_path, encoding="utf-8") as f:
        idx = json.load(f)

    # ── 1. 좌표 변환 왕복 ──
    worst = 0.0
    for la, lo in [(37.4845, 127.0341), (37.4930, 127.0430), (37.4760, 127.0250),
                   (37.4845, 127.0250), (37.4760, 127.0430)]:
        x, z = to_local(la, lo)
        la2, lo2 = to_latlon(x, z)
        d = math.hypot((la - la2) * M_PER_DEG_LAT, (lo - lo2) * M_PER_DEG_LON)
        worst = max(worst, d)
    check("좌표 왕복 오차 < 1mm", worst < 0.001, f"최대 {worst*1000:.4f}mm")

    # 파이썬과 자바스크립트가 같은 상수를 쓰는가
    check("index.json 의 원점이 config.py 와 같다",
          abs(idx["origin"]["lat"] - ORIGIN_LAT) < 1e-9 and abs(idx["origin"]["lon"] - ORIGIN_LON) < 1e-9)
    check("index.json 의 1도당 거리가 config.py 와 같다",
          abs(idx["mPerDegLat"] - M_PER_DEG_LAT) < 1e-6 and abs(idx["mPerDegLon"] - M_PER_DEG_LON) < 1e-6)
    check("청크 크기 일치", idx["chunkSize"] == CHUNK_SIZE_M)

    # ── 2. 청크 파일 목록이 index 와 정확히 일치 ──
    cdir = os.path.join(ROOT, "web", "data", "chunks")
    files = {os.path.basename(p)[:-5] for p in glob.glob(os.path.join(cdir, "*.json"))}
    listed = {f"{c['cx']}_{c['cz']}" for c in idx["chunks"]}
    check("index 에 적힌 청크가 모두 파일로 있다", listed <= files,
          f"없는 것 {sorted(listed - files)[:5]}")
    check("파일만 있고 index 에 없는 청크가 없다", files <= listed,
          f"떠도는 파일 {sorted(files - listed)[:5]}")

    # ── 3. 내용 검사 ──
    nb = ngen = nroad = npoi = 0
    bad_poly = bad_h = bad_front = bad_chunk = bad_road = 0
    poi_far = 0
    heights = []
    road_len_by_id = {}
    all_ids = set()
    dup_ids = 0

    for key in sorted(listed):
        cx, cz = map(int, key.split("_"))
        with open(os.path.join(cdir, key + ".json"), encoding="utf-8") as f:
            d = json.load(f)
        if d.get("cx") != cx or d.get("cz") != cz:
            bad_chunk += 1

        for b in d.get("buildings", []):
            nb += 1
            ngen += b.get("gen", 0)
            if b["id"] in all_ids:
                dup_ids += 1
            all_ids.add(b["id"])
            poly = b.get("poly") or []
            if len(poly) < 3 or any(len(p) != 2 or any(not math.isfinite(v) for v in p) for p in poly):
                bad_poly += 1
                continue
            # 파이썬이 반시계로 정규화했는가 (자바스크립트의 바깥법선 계산이 여기 의존)
            if G.signed_area([tuple(p) for p in poly]) <= 0:
                bad_poly += 1
            if not (2.0 <= b.get("h", 0) <= 400):
                bad_h += 1
            heights.append(b["h"])
            for i in b.get("front", []):
                if not (0 <= i < len(poly)):
                    bad_front += 1
            # 청크 배정이 맞는가(무게중심이 이 청크 안이어야 한다)
            gx, gz = G.centroid([tuple(p) for p in poly])
            if (int(math.floor(gx / CHUNK_SIZE_M)), int(math.floor(gz / CHUNK_SIZE_M))) != (cx, cz):
                bad_chunk += 1
            # 붙은 상호가 정말 이 건물 근처인가 (엉뚱한 건물에 붙는 사고 방지)
            for p in b.get("pois", []):
                npoi += 1
                if math.hypot(p["dx"], p["dz"]) > 60:
                    poi_far += 1

        for r in d.get("roads", []):
            nroad += 1
            if r.get("w", 0) <= 0 or len(r.get("pts", [])) < 2 or not (1 <= r.get("lanes", 0) <= 12):
                bad_road += 1
                continue
            L = sum(math.hypot(r["pts"][i + 1][0] - r["pts"][i][0],
                               r["pts"][i + 1][1] - r["pts"][i][1])
                    for i in range(len(r["pts"]) - 1))
            road_len_by_id[r["id"]] = road_len_by_id.get(r["id"], 0.0) + L

    check("건물 폴리곤 이상 없음", bad_poly == 0, f"{bad_poly}건")
    check("건물 높이 범위 정상", bad_h == 0, f"{bad_h}건")
    check("도로접면(front) 인덱스 범위 정상", bad_front == 0, f"{bad_front}건")
    check("청크 배정 정확", bad_chunk == 0, f"{bad_chunk}건")
    check("도로 속성 정상", bad_road == 0, f"{bad_road}건")
    check("건물 id 중복 없음", dup_ids == 0, f"{dup_ids}건")
    check("상호가 붙은 건물에서 60m 이내", poi_far == 0, f"{poi_far}건")

    # ── 4. 도로를 청크로 자르면서 길이가 사라지지 않았는가 ──
    # (원본에서 다시 계산해 총 길이를 맞춰 본다)
    raw_path = os.path.join(ROOT, "data", "raw", "osm_raw.json")
    if os.path.exists(raw_path):
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        import build_scene as BS
        with open(raw_path, encoding="utf-8") as f:
            els = json.load(f)["elements"]
        R = idx["builtRadius"]
        orig = {}
        for e in els:
            t = e.get("tags") or {}
            hw = t.get("highway")
            if not hw or e["type"] != "way":
                continue
            base = BS.LINK_OF.get(hw, hw)
            if base not in BS.ROAD_SPEC:
                continue
            if t.get("footway") == "crossing" or (hw == "footway" and t.get("crossing")):
                continue
            g = [p for p in (e.get("geometry") or []) if p]
            pts = BS.drop_dupes([to_local(p["lat"], p["lon"]) for p in g])
            if len(pts) < 2:
                continue
            if not any(math.hypot(p[0], p[1]) <= R + 60 for p in pts):
                continue
            pts = G.simplify(pts, 0.4)
            orig[f"w{e['id']}"] = G.polyline_length([(round(p[0], 2), round(p[1], 2)) for p in pts])

        common = set(orig) & set(road_len_by_id)
        check("잘린 도로가 원본에도 다 있다", len(set(road_len_by_id) - set(orig)) == 0,
              f"원본에 없는 것 {len(set(road_len_by_id) - set(orig))}개")
        worst_id, worst_err = None, 0.0
        for k in common:
            err = abs(orig[k] - road_len_by_id[k])
            if err > worst_err:
                worst_err, worst_id = err, k
        check("청크로 자른 뒤에도 도로 총길이 보존 (오차 < 1m)", worst_err < 1.0,
              f"최대 오차 {worst_err:.3f}m ({worst_id})")
        lost = [k for k in orig if k not in road_len_by_id]
        warn("원본 도로가 하나도 안 사라짐", len(lost) == 0, f"{len(lost)}개 누락")
    else:
        WARN.append("원본이 없어 도로 길이 보존 검사를 건너뜀")

    # ── 5. 명소가 정말 건물 밖인가 ──
    polys = []
    for key in listed:
        with open(os.path.join(cdir, key + ".json"), encoding="utf-8") as f:
            for b in json.load(f).get("buildings", []):
                polys.append([tuple(p) for p in b["poly"]])
    bad_spot = []
    for sp in idx.get("spots", []):
        if sp.get("mode") == "orbit" or sp["cam"][1] > 8:
            continue                      # 항공·옥상은 건물 위가 정상
        x, z = sp["cam"][0], sp["cam"][2]
        for ring in polys:
            bb = G.bbox(ring)
            if bb[0] - 2 <= x <= bb[2] + 2 and bb[1] - 2 <= z <= bb[3] + 2 and G.point_in_ring((x, z), ring):
                bad_spot.append(sp["name"])
                break
    check("명소가 건물 안에 있지 않다", not bad_spot, ", ".join(bad_spot))

    # ── 6. 규모 ──
    heights.sort()
    print("\n" + "=" * 62)
    print(f"  건물 {nb:,}동 (OSM {nb-ngen:,} / 생성 {ngen:,})")
    print(f"  도로조각 {nroad:,} · 실제 상호 {npoi:,} · 청크 {len(listed)}")
    if heights:
        print(f"  높이 중앙값 {heights[len(heights)//2]:.1f}m · 최고 {heights[-1]:.1f}m")
    print("=" * 62)

    print(f"\n  통과 {len(OK)}건")
    for w in WARN:
        print(f"  [주의] {w}")
    for f in FAIL:
        print(f"  [실패] {f}")
    print()
    if FAIL:
        print("  ❌ 문제가 있습니다. 위 [실패] 항목을 고쳐야 합니다.")
        return 1
    print("  ✅ 데이터 검증 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
