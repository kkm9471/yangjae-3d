# -*- coding: utf-8 -*-
"""OSM 원본 → 3D 씬용 청크 데이터.

역할 분담
  파이썬(여기): 실제 세계의 '사실'만 다룬다.
      위경도→미터 변환, 건물 외곽선·높이, 도로 중심선·폭, 횡단보도, 공원/물,
      그리고 OSM에 건물이 비어 있는 도로변을 메우는 '생성 건물'.
  자바스크립트(웹): 사실 위에 '연출'을 얹는다.
      간판, 가로수, 가로등, 보행자, 차량, 창문 불빛.
  → 데이터 파일이 작아지고, 연출 밀도는 화면에서 바로 조절할 수 있다.

출력
  web/data/index.json          씬 메타 + 청크 목록
  web/data/chunks/<cx>_<cz>.json

사용법: python tools/build_scene.py
"""
import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geom as G                      # noqa: E402
from config import (ORIGIN_LAT, ORIGIN_LON, RAW_RADIUS_M, CHUNK_SIZE_M,   # noqa: E402
                    M_PER_DEG_LAT, M_PER_DEG_LON, to_local)
from names import cat_of              # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_PATH = os.path.join(ROOT, "data", "raw", "osm_raw.json")
OUT_DIR = os.path.join(ROOT, "web", "data")
CHUNK_DIR = os.path.join(OUT_DIR, "chunks")

# ── 도로 규격: (편도 기본 차로수, 차로폭 m, 보도폭 m, 그리기 우선순위) ──
ROAD_SPEC = {
    "motorway":     (4, 3.6, 0.0, 8),
    "trunk":        (3, 3.5, 3.0, 7),
    "primary":      (3, 3.4, 3.5, 6),
    "secondary":    (2, 3.3, 3.0, 5),
    "tertiary":     (2, 3.2, 2.5, 4),
    "unclassified": (1, 3.2, 2.0, 3),
    "residential":  (1, 3.0, 2.0, 3),
    "living_street": (1, 3.0, 1.5, 2),
    "busway":       (1, 3.4, 0.0, 5),
    "service":      (1, 2.9, 0.0, 1),
    "pedestrian":   (1, 3.0, 0.0, 2),
    "track":        (1, 2.8, 0.0, 1),
}
LINK_OF = {"motorway_link": "motorway", "trunk_link": "trunk", "primary_link": "primary",
           "secondary_link": "secondary", "tertiary_link": "tertiary"}
FOOT_CLASSES = {"footway", "path", "steps", "cycleway", "platform", "corridor", "bridleway"}

# 생성 건물을 만들 도로 등급 (골목까지 채워야 도시가 이 빠진 느낌이 안 난다)
FILLABLE = {"primary", "secondary", "tertiary", "residential", "unclassified", "living_street"}

# 층수→높이 추정에 쓰는 층고
FLOOR_H = 3.35
GROUND_FLOOR_H = 4.3


def h32(*vals) -> int:
    """결정적 해시. 같은 입력 → 항상 같은 출력(빌드 재현성)."""
    x = 0x811C9DC5
    for v in vals:
        v = int(v) & 0xFFFFFFFF
        x = (x ^ v) & 0xFFFFFFFF
        x = (x * 16777619) & 0xFFFFFFFF
        x ^= (x >> 15)
    return x


def frand(seed, salt=0):
    return (h32(seed, salt) % 100000) / 100000.0


# ─────────────────────────── 공간 격자 인덱스 ───────────────────────────
class Grid:
    """생성 건물이 기존 건물/도로/공원과 겹치는지 빠르게 검사하기 위한 격자."""

    def __init__(self, cell=25.0):
        self.cell = cell
        self.d = defaultdict(list)

    def _keys(self, bb):
        c = self.cell
        for gx in range(int(math.floor(bb[0] / c)), int(math.floor(bb[2] / c)) + 1):
            for gz in range(int(math.floor(bb[1] / c)), int(math.floor(bb[3] / c)) + 1):
                yield (gx, gz)

    def insert(self, ring):
        bb = G.bbox(ring)
        for k in self._keys(bb):
            self.d[k].append((bb, ring))

    def hits(self, ring):
        bb = G.bbox(ring)
        seen = set()
        for k in self._keys(bb):
            for item in self.d.get(k, ()):
                if id(item[1]) in seen:
                    continue
                seen.add(id(item[1]))
                ob = item[0]
                if bb[2] < ob[0] or ob[2] < bb[0] or bb[3] < ob[1] or ob[3] < bb[1]:
                    continue
                if G.rings_overlap(ring, item[1]):
                    return True
        return False


# ─────────────────────────── 파싱 ───────────────────────────
def parse_height(tags, footprint_area, seed):
    """높이(m)를 정한다. 실제 태그 > 층수 > 용도·규모 추정 순."""
    def num(v):
        try:
            return float(str(v).strip().split()[0].replace("m", ""))
        except Exception:
            return None

    h = num(tags.get("height")) or num(tags.get("building:height"))
    if h and 2.0 < h < 400:
        return h, "height태그"

    lv = num(tags.get("building:levels")) or num(tags.get("levels"))
    if lv and 0 < lv < 120:
        return GROUND_FLOOR_H + (lv - 1) * FLOOR_H, "층수태그"

    b = tags.get("building", "yes")
    base = {
        "apartments": 42, "residential": 18, "commercial": 24, "office": 30, "officetel": 45,
        "retail": 12, "house": 7, "detached": 8, "school": 14, "church": 12, "hotel": 40,
        "kindergarten": 9, "hospital": 26, "industrial": 11, "warehouse": 9, "parking": 14,
        "roof": 4.5, "garage": 3.2, "garages": 3.2, "hut": 3, "shed": 3, "service": 4,
    }.get(b, 0)
    if base == 0:
        # 용도를 모르면 바닥면적으로 가늠한다(큰 필지 = 대개 큰 건물)
        a = footprint_area
        base = 9 if a < 120 else 14 if a < 350 else 22 if a < 900 else 34
    jitter = 0.78 + 0.44 * frand(seed, 7)
    return max(3.0, base * jitter), "추정"


def drop_dupes(pts, eps=0.05):
    """연속으로 같은 자리인 점 제거(폴리라인용)."""
    out = []
    for p in pts:
        if out and math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) < eps:
            continue
        out.append(p)
    return out


def rings_from_element(e):
    """way / multipolygon relation → (outer, [holes]) 목록."""
    out = []
    if e["type"] == "way":
        g = e.get("geometry") or []
        ring = G.dedupe_ring([to_local(p["lat"], p["lon"]) for p in g if p])
        if len(ring) >= 3:
            out.append((ring, []))
    elif e["type"] == "relation":
        outers, inners = [], []
        for m in e.get("members", []):
            g = m.get("geometry") or []
            ring = G.dedupe_ring([to_local(p["lat"], p["lon"]) for p in g if p])
            if len(ring) < 3:
                continue
            (outers if m.get("role") != "inner" else inners).append(ring)
        for o in outers:
            hs = [h for h in inners if G.point_in_ring(h[0], o)]
            out.append((o, hs))
    return out


def load(raw_path):
    with open(raw_path, encoding="utf-8") as f:
        doc = json.load(f)
    return doc.get("elements", [])


# ─────────────────────────── 메인 빌드 ───────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--radius", type=int, default=RAW_RADIUS_M,
                    help="청크를 만들 최대 반경(m). 기본=원본 반경 전체")
    ap.add_argument("--no-fill", action="store_true", help="생성 건물 채우기 끄기")
    ap.add_argument("--fill-density", type=float, default=1.0)
    args = ap.parse_args()
    R = args.radius

    t0 = time.time()
    print(f"[읽기] {RAW_PATH}")
    els = load(RAW_PATH)
    print(f"       요소 {len(els):,}개")

    buildings = []     # dict
    roads = []
    footways = []
    crossings = []
    areas = []
    props = []
    pois = []

    stat = defaultdict(int)

    for e in els:
        t = e.get("tags") or {}
        etype = e["type"]
        eid = e["id"]

        # ── 간판이 될 상호 (건물/도로 분기의 continue 보다 먼저 처리) ──
        _nm = t.get("name")
        if _nm and any(k in t for k in ("shop", "amenity", "office", "leisure", "craft", "healthcare", "tourism"))                 and t.get("amenity") not in ("parking", "bicycle_parking", "bench", "waste_basket",
                                             "recycling", "shelter", "toilets", "drinking_water",
                                             "bicycle_rental", "atm", "vending_machine"):
            _p = None
            if etype == "node":
                _p = to_local(e["lat"], e["lon"])
            else:
                _rs = rings_from_element(e)
                if _rs:
                    _p = G.centroid(_rs[0][0])
            if _p and math.hypot(_p[0], _p[1]) <= R:
                _lvl = t.get("level")
                try:
                    _fl = int(float(str(_lvl).split(";")[0])) + 1 if _lvl is not None else 0
                except Exception:
                    _fl = 0
                pois.append({"n": _nm[:24], "c": cat_of(t), "x": round(_p[0], 2), "z": round(_p[1], 2),
                             "f": max(0, min(12, _fl))})
                stat["상호"] += 1

        # ── 건물 ──
        if "building" in t and t.get("building") != "no":
            for outer, holes in rings_from_element(e):
                a = G.area(outer)
                if a < 8:
                    stat["건물_너무작아버림"] += 1
                    continue
                seed = h32(eid, 1)
                h, how = parse_height(t, a, seed)
                cx, cz = G.centroid(outer)
                if math.hypot(cx, cz) > R:
                    continue
                buildings.append({
                    "id": f"{etype[0]}{eid}",
                    "poly": [[round(p[0], 2), round(p[1], 2)] for p in G.simplify(outer, 0.35, True)],
                    "holes": [[[round(p[0], 2), round(p[1], 2)] for p in G.simplify(hh, 0.35, True)] for hh in holes],
                    "h": round(h, 2),
                    "minh": 0.0,
                    "cat": t.get("building", "yes"),
                    "name": t.get("name") or "",
                    "gen": 0,
                    "seed": seed % 100000,
                    "area": round(a, 1),
                })
                stat["높이_" + how] += 1
            continue

        # ── 도로 ──
        hw = t.get("highway")
        if hw and etype == "way":
            g = e.get("geometry") or []
            pts = drop_dupes([to_local(p["lat"], p["lon"]) for p in g if p])
            if len(pts) < 2:
                continue
            if not any(math.hypot(p[0], p[1]) <= R + 60 for p in pts):
                continue
            layer = 0
            try:
                layer = int(float(t.get("layer", 0)))
            except Exception:
                layer = 0
            tunnel = t.get("tunnel") in ("yes", "building_passage", "culvert") or layer < 0
            bridge = t.get("bridge") in ("yes", "viaduct") or layer > 0

            if t.get("footway") == "crossing" or (hw == "footway" and t.get("crossing")):
                crossings.append({
                    "pts": [[round(p[0], 2), round(p[1], 2)] for p in G.simplify(pts, 0.2)],
                    "kind": t.get("crossing", "marked"),
                })
                stat["횡단보도way"] += 1
                continue

            if hw in FOOT_CLASSES:
                footways.append({
                    "id": f"w{eid}",
                    "pts": [[round(p[0], 2), round(p[1], 2)] for p in G.simplify(pts, 0.4)],
                    "cls": hw, "layer": layer, "tunnel": int(tunnel),
                })
                continue

            base = LINK_OF.get(hw, hw)
            spec = ROAD_SPEC.get(base)
            if spec is None:
                continue
            deflanes, lanew, sw, zo = spec
            oneway = 1 if t.get("oneway") in ("yes", "-1", "true", "1") else 0
            try:
                lanes = int(float(t.get("lanes")))
            except Exception:
                lanes = deflanes * (1 if oneway else 2)
            lanes = max(1, min(12, lanes))
            width = lanes * lanew
            if hw in LINK_OF:
                width = min(width, lanew * 2.2)
                zo -= 1
            try:
                width = float(t.get("width")) if t.get("width") else width
            except Exception:
                pass
            roads.append({
                "id": f"w{eid}",
                "pts": [[round(p[0], 2), round(p[1], 2)] for p in G.simplify(pts, 0.4)],
                "cls": base, "w": round(width, 2), "sw": sw, "lanes": lanes,
                "oneway": oneway, "layer": layer, "z": zo,
                "tunnel": int(tunnel), "bridge": int(bridge),
                "name": t.get("name", ""),
            })
            stat["도로_" + base] += 1
            continue

        # ── 면(공원/물/주차장/운동장) ──
        if etype in ("way", "relation"):
            kind = None
            if t.get("leisure") in ("park", "garden", "playground", "pitch", "sports_centre"):
                kind = "green" if t.get("leisure") in ("park", "garden") else "pitch"
            elif t.get("landuse") in ("grass", "forest", "meadow", "recreation_ground", "village_green"):
                kind = "green"
            elif t.get("natural") in ("water", "wood", "scrub", "grassland"):
                kind = "water" if t.get("natural") == "water" else "green"
            elif t.get("waterway") in ("riverbank",) or t.get("water"):
                kind = "water"
            elif t.get("amenity") == "parking":
                kind = "parking"
            if kind:
                for outer, holes in rings_from_element(e):
                    if G.area(outer) < 25:
                        continue
                    cx, cz = G.centroid(outer)
                    if math.hypot(cx, cz) > R + 50:
                        continue
                    areas.append({
                        "kind": kind,
                        "poly": [[round(p[0], 2), round(p[1], 2)] for p in G.simplify(outer, 0.6, True)],
                        "holes": [[[round(p[0], 2), round(p[1], 2)] for p in G.simplify(hh, 0.6, True)] for hh in holes],
                    })
                    stat["면_" + kind] += 1

        # ── 점 요소 ──
        if etype == "node":
            x, z = to_local(e["lat"], e["lon"])
            if math.hypot(x, z) > R:
                continue
            hw = t.get("highway")
            kind = None
            if hw == "traffic_signals":
                kind = "signal"
            elif hw == "crossing":
                kind = "crossnode"
            elif hw == "street_lamp":
                kind = "lamp"
            elif hw == "bus_stop" or t.get("public_transport") == "platform":
                kind = "busstop"
            elif t.get("railway") == "subway_entrance":
                kind = "subway"
            elif t.get("natural") == "tree":
                kind = "tree"
            elif t.get("amenity") == "bicycle_rental":
                kind = "bike"
            if kind:
                props.append({"kind": kind, "x": round(x, 2), "z": round(z, 2),
                              "name": t.get("name", "")})
                stat["점_" + kind] += 1

    print(f"[파싱] 건물 {len(buildings):,} / 도로 {len(roads):,} / 보행로 {len(footways):,} / "
          f"횡단보도 {len(crossings):,} / 면 {len(areas):,} / 점 {len(props):,} / 상호 {len(pois):,}")

    # ── 생성 건물로 도로변 빈틈 메우기 ──
    gen_count = 0
    if not args.no_fill:
        gen = fill_streets(roads, buildings, areas, R, args.fill_density)
        buildings.extend(gen)
        gen_count = len(gen)
        print(f"[채움] 생성 건물 {gen_count:,}동 추가 (OSM 실제 {len(buildings)-gen_count:,}동)")

    # ── 건물의 도로 접면(간판 붙을 벽) 계산 ──
    compute_frontage(buildings, roads)

    # ── 상호를 건물에 붙이기 (ID 기준. 배열 순서에 의존하지 않는다) ──
    attach_pois(buildings, pois)

    # ── 청크로 나눠 쓰기 ──
    write_chunks(buildings, roads, footways, crossings, areas, props, R)

    dt = time.time() - t0
    print(f"[완료] {dt:.1f}초")


# ─────────────────────────── 도로변 채우기 ───────────────────────────
def fill_streets(roads, buildings, areas, R, density):
    """OSM에 건물이 없는 도로변에 그럴듯한 건물을 만들어 넣는다.
    도시가 '이 빠진' 느낌이 나는 걸 막는 게 목적이므로, 블록 내부가 아니라
    '길에서 보이는 벽면'을 우선 채운다."""
    grid = Grid(25.0)
    for b in buildings:
        grid.insert([tuple(p) for p in b["poly"]])
    for a in areas:
        if a["kind"] in ("green", "water", "pitch"):
            grid.insert([tuple(p) for p in a["poly"]])

    # 도로 자체도 막이(생성 건물이 도로 위로 올라오면 안 됨)
    for r in roads:
        pts = r["pts"]
        half = r["w"] / 2 + max(1.0, r["sw"])
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            dx, dz = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dz) or 1.0
            nx, nz = -dz / L * half, dx / L * half
            grid.insert([(a[0] + nx, a[1] + nz), (b[0] + nx, b[1] + nz),
                         (b[0] - nx, b[1] - nz), (a[0] - nx, a[1] - nz)])

    out = []
    order = {"primary": 0, "secondary": 1, "tertiary": 2, "unclassified": 3,
             "residential": 4, "living_street": 5}
    for r in sorted(roads, key=lambda x: order.get(x["cls"], 9)):
        if r["cls"] not in FILLABLE or r["tunnel"] or r["bridge"]:
            continue
        pts = [tuple(p) for p in r["pts"]]
        if G.polyline_length(pts) < 18:
            continue
        setback = r["w"] / 2 + max(2.0, r["sw"]) + 1.2
        base_seed = h32(int(r["id"][1:]), 3)

        for side in (1, -1):
            line = G.offset_polyline(pts, setback * side)
            total = G.polyline_length(line)
            s = 2.0 + 6.0 * frand(base_seed, side + 5)
            k = 0
            while s < total - 8:
                k += 1
                sd = h32(base_seed, int(s * 10) * 7 + (side + 3))
                front = 8.0 + 16.0 * frand(sd, 1)          # 도로에 접한 폭
                depth = 11.0 + 15.0 * frand(sd, 2)         # 안쪽 깊이
                p0 = point_at(line, s)
                p1 = point_at(line, min(total - 0.1, s + front))
                if p0 is None or p1 is None:
                    break
                dx, dz = p1[0] - p0[0], p1[1] - p0[1]
                L = math.hypot(dx, dz)
                if L < 4:
                    s += front
                    continue
                # 도로 반대편(바깥)으로 나가는 법선
                nx, nz = (-dz / L) * side, (dx / L) * side
                q0 = (p0[0] + nx * depth, p0[1] + nz * depth)
                q1 = (p1[0] + nx * depth, p1[1] + nz * depth)
                ring = [p0, p1, q1, q0]

                cx, cz = G.centroid(ring)
                if math.hypot(cx, cz) > R:
                    s += front + 1.0
                    continue
                if frand(sd, 9) > density:
                    s += front + 2.0 + 6.0 * frand(sd, 4)
                    continue
                if grid.hits(ring):
                    s += 4.0
                    continue

                floors = pick_floors(r["cls"], sd)
                h = GROUND_FLOOR_H + (floors - 1) * FLOOR_H
                out.append({
                    "id": f"g{r['id'][1:]}_{side}_{k}",
                    "poly": [[round(p[0], 2), round(p[1], 2)] for p in ring],
                    "holes": [], "h": round(h, 2), "minh": 0.0,
                    "cat": "commercial" if floors <= 8 else "office",
                    "name": "", "gen": 1, "seed": sd % 100000,
                    "area": round(G.area(ring), 1),
                })
                grid.insert(ring)
                s += front + 0.6 + 2.4 * frand(sd, 6)
    return out


def pick_floors(cls, sd):
    r = frand(sd, 3)
    if cls == "primary":
        return int(4 + r * r * 14)
    if cls == "secondary":
        return int(3 + r * r * 10)
    if cls == "tertiary":
        return int(3 + r * r * 7)
    if cls in ("residential", "unclassified"):
        return int(2 + r * r * 5)
    return int(2 + r * 3)


def point_at(line, s):
    """폴리라인 위 거리 s 지점."""
    acc = 0.0
    for i in range(len(line) - 1):
        a, b = line[i], line[i + 1]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if acc + L >= s:
            t = (s - acc) / (L or 1.0)
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        acc += L
    return None


# ─────────────────────────── 건물의 도로 접면 계산 ───────────────────────────
def compute_frontage(buildings, roads, max_dist=26.0):
    """각 건물 외곽선에서 '길에서 보이는 변'의 인덱스를 구한다.
    간판·1층 상가는 여기에만 붙는다. 도로 전체를 아는 파이썬에서 계산해야
    청크 경계 너머의 도로도 놓치지 않는다."""
    CELL = 40.0
    grid = defaultdict(list)
    for r in roads:
        if r["tunnel"]:
            continue
        pts = r["pts"]
        for i in range(len(pts) - 1):
            a, b = tuple(pts[i]), tuple(pts[i + 1])
            x0, x1 = sorted((a[0], b[0]))
            z0, z1 = sorted((a[1], b[1]))
            for gx in range(int(x0 // CELL), int(x1 // CELL) + 1):
                for gz in range(int(z0 // CELL), int(z1 // CELL) + 1):
                    grid[(gx, gz)].append((a, b, r["w"], r["z"]))

    n_front = 0
    for bd in buildings:
        ring = [tuple(p) for p in bd["poly"]]
        n = len(ring)
        if G.signed_area(ring) < 0:
            ring = ring[::-1]
            bd["poly"] = [[p[0], p[1]] for p in ring]
        cand = []          # (edge_index, 도로까지 거리, 도로등급)
        best_rank = -1
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            dx, dz = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dz)
            if L < 2.0:
                continue
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            nx, nz = dz / L, -dx / L          # 반시계 링의 바깥 법선
            probe = (mid[0] + nx * 1.0, mid[1] + nz * 1.0)
            gk = (int(probe[0] // CELL), int(probe[1] // CELL))
            best = None
            for ddx in (-1, 0, 1):
                for ddz in (-1, 0, 1):
                    for (ra, rb, rw, rz) in grid.get((gk[0] + ddx, gk[1] + ddz), ()):
                        d, q, _ = G.dist_point_seg(mid, ra, rb)
                        d -= rw / 2.0
                        if d > max_dist:
                            continue
                        # 도로가 '바깥 법선 쪽'에 확실히 있어야 접면이다.
                        # (뒷벽이 다른 골목에 26m 이내라는 이유로 간판이 붙는 걸 막는다)
                        dot = (q[0] - mid[0]) * nx + (q[1] - mid[1]) * nz
                        if dot < 0.55 * max(d, 0.8):
                            continue
                        if best is None or d < best[0]:
                            best = (d, rz)
            if best is not None:
                cand.append((i, best[0], best[1]))

        front = []
        if cand:
            dmin = min(c[1] for c in cand)
            for (i, d, rz) in cand:
                if d <= dmin + 6.0 and d <= 16.0:
                    front.append(i)
                    if rz > best_rank:
                        best_rank = rz
        bd["front"] = front
        bd["rank"] = max(0, best_rank)      # 접한 가장 큰 도로 등급(간판 밀도에 사용)
        n_front += len(front)
    print(f"[접면] 건물당 평균 {n_front/max(1,len(buildings)):.1f}개 변이 도로에 접함")


# ─────────────────────────── 상호 → 건물 부착 ───────────────────────────
def attach_pois(buildings, pois):
    """가게(상호)를 가장 가까운 건물에 붙인다.
    ★ 배열 인덱스가 아니라 건물 id 로 연결한다 — 나중에 목록 순서가 바뀌어도
      엉뚱한 건물에 엉뚱한 간판이 붙는 사고가 나지 않게."""
    grid = defaultdict(list)
    CELL = 40.0
    for b in buildings:
        cx, cz = G.centroid([tuple(p) for p in b["poly"]])
        b["_c"] = (cx, cz)
        b.setdefault("pois", [])
        gk = (int(cx // CELL), int(cz // CELL))
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                grid[(gk[0] + dx, gk[1] + dz)].append(b)

    attached = 0
    for p in pois:
        gk = (int(p["x"] // CELL), int(p["z"] // CELL))
        best, bestd = None, 1e9
        for b in grid.get(gk, ()):
            ring = [tuple(q) for q in b["poly"]]
            n = len(ring)
            d = min(G.dist_point_seg((p["x"], p["z"]), ring[i], ring[(i + 1) % n])[0] for i in range(n))
            if d < bestd:
                best, bestd = b, d
        if best is not None and bestd < 28.0:
            best["pois"].append({"n": p["n"], "c": p["c"], "f": p["f"],
                                 "dx": round(p["x"] - best["_c"][0], 1),
                                 "dz": round(p["z"] - best["_c"][1], 1)})
            attached += 1
    for b in buildings:
        b.pop("_c", None)
    print(f"[간판] 실제 상호 {attached:,}/{len(pois):,} 개를 건물에 부착")


# ─────────────────────────── 청크 분할·저장 ───────────────────────────
def ckey(x, z, cs=CHUNK_SIZE_M):
    return (int(math.floor(x / cs)), int(math.floor(z / cs)))


def split_segment_by_chunk(a, b, cs=CHUNK_SIZE_M):
    """선분 a→b 를 청크 경계에서 잘라 [(key, p, q), ...] 로 돌려준다.
    중복 없이, 빈틈 없이 나눈다."""
    ts = {0.0, 1.0}
    for axis in (0, 1):
        a0, b0 = a[axis], b[axis]
        if abs(b0 - a0) < 1e-9:
            continue
        lo, hi = (a0, b0) if a0 < b0 else (b0, a0)
        i0 = int(math.floor(lo / cs)) + 1
        i1 = int(math.ceil(hi / cs))
        for i in range(i0, i1):
            v = i * cs
            t = (v - a0) / (b0 - a0)
            if 1e-9 < t < 1 - 1e-9:
                ts.add(t)
    tl = sorted(ts)
    out = []
    for t0, t1 in zip(tl, tl[1:]):
        if t1 - t0 < 1e-7:
            continue
        p = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
        q = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
        m = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        out.append((ckey(m[0], m[1], cs), p, q))
    return out


def split_polyline_by_chunk(pts, cs=CHUNK_SIZE_M):
    """폴리라인을 청크별 조각 목록으로. {key: [[pt,...], ...]}"""
    runs = defaultdict(list)
    cur_key, cur = None, []
    for i in range(len(pts) - 1):
        for key, p, q in split_segment_by_chunk(tuple(pts[i]), tuple(pts[i + 1]), cs):
            if key != cur_key:
                if len(cur) >= 2:
                    runs[cur_key].append(cur)
                cur_key, cur = key, [p, q]
            else:
                cur.append(q)
    if len(cur) >= 2:
        runs[cur_key].append(cur)
    return runs


def rnd2(pts):
    return [[round(p[0], 2), round(p[1], 2)] for p in pts]


def write_chunks(buildings, roads, footways, crossings, areas, props, R):
    os.makedirs(CHUNK_DIR, exist_ok=True)
    for f in os.listdir(CHUNK_DIR):
        if f.endswith(".json"):
            os.remove(os.path.join(CHUNK_DIR, f))

    chunks = defaultdict(lambda: {"buildings": [], "roads": [], "footways": [],
                                  "crossings": [], "areas": [], "props": []})

    for b in buildings:
        cx, cz = G.centroid([tuple(p) for p in b["poly"]])
        chunks[ckey(cx, cz)]["buildings"].append(b)

    def put_lines(items, bucket, keep):
        for it in items:
            for key, runs in split_polyline_by_chunk(it["pts"]).items():
                for run in runs:
                    o = {k: it[k] for k in keep if k in it}
                    o["pts"] = rnd2(run)
                    chunks[key][bucket].append(o)

    put_lines(roads, "roads", ("id", "cls", "w", "sw", "lanes", "oneway", "layer", "z",
                               "tunnel", "bridge", "name"))
    put_lines(footways, "footways", ("id", "cls", "layer", "tunnel"))
    put_lines(crossings, "crossings", ("kind",))

    for a in areas:
        cx, cz = G.centroid([tuple(p) for p in a["poly"]])
        chunks[ckey(cx, cz)]["areas"].append(a)
    for p in props:
        chunks[ckey(p["x"], p["z"])]["props"].append(p)

    index = {
        "origin": {"lat": ORIGIN_LAT, "lon": ORIGIN_LON},
        "mPerDegLat": M_PER_DEG_LAT,
        "mPerDegLon": M_PER_DEG_LON,
        "chunkSize": CHUNK_SIZE_M,
        "builtRadius": R,
        "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "chunks": [],
        "totals": {},
    }
    tot = defaultdict(int)
    written = 0
    for key, c in sorted(chunks.items()):
        n = sum(len(v) for v in c.values())
        if n == 0:
            continue
        name = f"{key[0]}_{key[1]}.json"
        with open(os.path.join(CHUNK_DIR, name), "w", encoding="utf-8") as f:
            json.dump({"cx": key[0], "cz": key[1], **c}, f, ensure_ascii=False,
                      separators=(",", ":"))
        written += 1
        index["chunks"].append({
            "cx": key[0], "cz": key[1],
            "b": len(c["buildings"]), "r": len(c["roads"]), "f": len(c["footways"]),
            "x": len(c["crossings"]), "a": len(c["areas"]), "p": len(c["props"]),
        })
        for k, v in c.items():
            tot[k] += len(v)

    tot["buildings_osm"] = sum(1 for b in buildings if not b["gen"])
    tot["buildings_gen"] = sum(1 for b in buildings if b["gen"])
    tot["pois"] = sum(len(b.get("pois", [])) for b in buildings)
    index["totals"] = dict(tot)

    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    size = sum(os.path.getsize(os.path.join(CHUNK_DIR, f)) for f in os.listdir(CHUNK_DIR))
    print(f"[저장] 청크 {written}개 / {size/1048576:.1f} MB → {CHUNK_DIR}")
    for k, v in sorted(index["totals"].items(), key=lambda x: -x[1]):
        print(f"       {k:16s} {v:,}")


if __name__ == "__main__":
    main()
