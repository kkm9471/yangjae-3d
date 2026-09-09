# -*- coding: utf-8 -*-
"""프로젝트 전역 상수. 파이썬 쪽과 웹(JS) 쪽이 같은 값을 써야 하므로
   이 파일이 '원본'이고, build_scene.py 가 web/data/index.json 으로 값을 내보낸다.
   JS는 index.json 을 읽는다 → 두 곳에 숫자를 두 번 적는 실수를 구조적으로 막는다."""

# ── 원점(원점이 바뀌면 이미 만든 모든 좌표가 어긋난다. 절대 바꾸지 말 것) ──
# 양재역 사거리 = 강남대로(상·하행 중앙) × 남부순환로(양재지하차도) 교차점.
# OSM 실제 도로 형상에서 계산한 값 (tools/README 참조).
ORIGIN_LAT = 37.484530
ORIGIN_LON = 127.034087

# ── 원본 수집 반경(m). 한 번만 크게 받아두고 재호출하지 않는다. ──
# 이 값이 곧 '만들어 두는 지도의 크기'다. 화면에 보이는 거리는 별개이며
# 실행 화면의 "보이는 거리" 슬라이더(150~1000m)로 조절한다.
# 1km 밖까지 넓히려면 이 값을 올리고 [원본다시받기.bat] 을 실행할 것.
RAW_RADIUS_M = 1000

# ── 청크(격자) 한 변 길이(m) ──
CHUNK_SIZE_M = 100

# ── 지구 반지름 기반 등거리 근사 상수 ──
# 1도당 거리(m). 위도 37.4845 기준. 수 km 범위에서 오차 0.1% 미만.
import math
_LAT = math.radians(ORIGIN_LAT)
M_PER_DEG_LAT = 111132.92 - 559.82 * math.cos(2 * _LAT) + 1.175 * math.cos(4 * _LAT)
M_PER_DEG_LON = 111412.84 * math.cos(_LAT) - 93.5 * math.cos(3 * _LAT)


def to_local(lat: float, lon: float):
    """위경도 → 로컬 미터 좌표.
    x = 동쪽(+), z = 남쪽(+)  ← three.js 오른손 좌표계에서 y가 위이므로
    북쪽이 -z가 되도록 맞춘다(카메라가 -z를 바라보는 기본 방향 = 북쪽)."""
    x = (lon - ORIGIN_LON) * M_PER_DEG_LON
    z = -(lat - ORIGIN_LAT) * M_PER_DEG_LAT
    return x, z


def to_latlon(x: float, z: float):
    lon = ORIGIN_LON + x / M_PER_DEG_LON
    lat = ORIGIN_LAT - z / M_PER_DEG_LAT
    return lat, lon
