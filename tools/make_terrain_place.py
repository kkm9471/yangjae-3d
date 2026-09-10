# -*- coding: utf-8 -*-
"""제주도를 '지형만 있는 동네'로 등록한다.

건물·도로는 아직 없다. 지형이 제대로 보이는지 먼저 확인하려는 것이다.
(빈 청크 하나만 두면 화면 쪽 코드가 그대로 돌아간다)
"""
import json, os, sys
ROOT = r"C:\Users\kkm\Desktop\Claude Code\yangjae-3d"
sys.path.insert(0, os.path.join(ROOT, "tools"))
import config as CF

slug, name = "jeju", "제주도"
lat, lon = 33.36, 126.55
CF.set_origin(lat, lon)

out = os.path.join(ROOT, "web", "data", "places", slug)
os.makedirs(os.path.join(out, "chunks"), exist_ok=True)

# 빈 청크 하나 (화면 코드가 청크 목록을 기대한다)
empty = {"cx": 0, "cz": 0, "buildings": [], "roads": [], "footways": [],
         "crossings": [], "areas": [], "props": [], "pois": []}
with open(os.path.join(out, "chunks", "0_0.json"), "w", encoding="utf-8") as f:
    json.dump(empty, f, ensure_ascii=False)

# 명소 — 제주에서 가 볼 만한 곳. 지형만 있어도 여기는 볼거리가 된다.
SPOTS = [
    ("한라산 정상",  33.361667, 126.529167, 60),
    ("성산일출봉",   33.458000, 126.942000, 40),
    ("제주공항",     33.510000, 126.492000, 30),
    ("서귀포 해안",  33.245000, 126.560000, 30),
    ("협재 해변",    33.394000, 126.240000, 25),
    ("송악산",       33.199000, 126.293000, 40),
]
spots = []
for nm, la, lo, h in SPOTS:
    x, z = CF.to_local(la, lo)
    # 지형만 있는 판이라 도로가 없다 → 걷기 대신 비행으로 둔다
    spots.append({"name": nm, "cam": [round(x, 1), h, round(z, 1)],
                  "look": [round(x + 400, 1), h * 0.3, round(z + 400, 1)],
                  "mode": "fly"})
# 섬 전체를 내려다보는 시점 (남쪽 바다 위 높은 곳에서 북쪽을 본다)
spots.append({"name": "제주도 전체", "cam": [0, 22000, 44000], "look": [0, 900, -2000],
              "mode": "fly"})
spots.append({"name": "바다에서 한라산", "cam": [-1900, 400, 26000], "look": [-1900, 1500, -200],
              "mode": "fly"})

index = {
    "name": name, "slug": slug,
    "origin": {"lat": lat, "lon": lon},
    "mPerDegLat": CF.M_PER_DEG_LAT, "mPerDegLon": CF.M_PER_DEG_LON,
    "chunkSize": 100, "builtRadius": 45000,
    "attribution": "지형: AWS terrarium (SRTM/ASTER 등)",
    # 실제 형식과 같아야 tests/verify.py 가 읽는다
    "chunks": [{"cx": 0, "cz": 0, "b": 0, "r": 0, "f": 0, "x": 0, "a": 0, "p": 0}],
    "spots": spots,
    "totals": {"buildings": 0, "roads": 0},
    "terrainOnly": True,
    "note": "지형만 있는 판. 건물·도로는 아직 없음.",
}
with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as f:
    json.dump(index, f, ensure_ascii=False, indent=1)

# places.json 에 추가
pj_path = os.path.join(ROOT, "web", "data", "places.json")
with open(pj_path, encoding="utf-8") as f:
    pj = json.load(f)
pj["places"] = [p for p in pj["places"] if p["slug"] != slug]
pj["places"].append({"slug": slug, "name": name, "lat": lat, "lon": lon,
                     "radius": 45000, "buildings": 0})
pj["places"].sort(key=lambda p: p["name"])
with open(pj_path, "w", encoding="utf-8") as f:
    json.dump(pj, f, ensure_ascii=False, indent=1)

print("제주도 등록 완료 · 명소 %d곳" % len(spots))
for s in spots:
    print("   %-12s cam=%s" % (s["name"], s["cam"]))
