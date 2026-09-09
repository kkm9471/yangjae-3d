# -*- coding: utf-8 -*-
"""프로젝트 전역 상수와 좌표 변환.

★ 여기 값들은 '지금 만들고 있는 동네' 하나를 가리킨다.
  동네를 바꾸려면 set_origin() 을 부른다. 그러면 to_local/to_latlon 도 함께 바뀐다.
  (다른 모듈이 `from config import to_local` 로 가져가도, 함수 안에서 이 모듈의
   전역을 그때그때 읽으므로 정상 동작한다. 반면 ORIGIN_LAT 같은 '값'은
   가져간 순간 고정되므로, 다른 모듈에서는 반드시 config.ORIGIN_LAT 로 쓸 것.)
"""
import math

# ── 기본 동네: 양재역 사거리 ──
# 강남대로(상·하행 중앙) × 남부순환로(양재지하차도) 교차점.
# 손으로 찍은 게 아니라 OSM 실제 도로 형상에서 계산한 값.
DEFAULT_LAT = 37.484530
DEFAULT_LON = 127.034087
DEFAULT_SLUG = "yangjae"
DEFAULT_NAME = "양재역 사거리"

ORIGIN_LAT = DEFAULT_LAT
ORIGIN_LON = DEFAULT_LON

# ── 원본 수집 반경(m). 한 번만 크게 받아두고 재호출하지 않는다. ──
# 이 값이 곧 '만들어 두는 지도의 크기'다. 화면에 보이는 거리는 별개이며
# 실행 화면의 "보이는 거리" 슬라이더(150~1000m)로 조절한다.
RAW_RADIUS_M = 1000

# ── 청크(격자) 한 변 길이(m) ──
CHUNK_SIZE_M = 100

M_PER_DEG_LAT = 0.0
M_PER_DEG_LON = 0.0


def set_origin(lat: float, lon: float):
    """지도의 중심을 옮긴다. 1도당 거리도 그 위도에 맞게 다시 계산한다."""
    global ORIGIN_LAT, ORIGIN_LON, M_PER_DEG_LAT, M_PER_DEG_LON
    ORIGIN_LAT = float(lat)
    ORIGIN_LON = float(lon)
    r = math.radians(ORIGIN_LAT)
    # 지구 반지름 기반 등거리 근사. 수 km 범위에서 오차 0.1% 미만.
    M_PER_DEG_LAT = 111132.92 - 559.82 * math.cos(2 * r) + 1.175 * math.cos(4 * r)
    M_PER_DEG_LON = 111412.84 * math.cos(r) - 93.5 * math.cos(3 * r)


set_origin(DEFAULT_LAT, DEFAULT_LON)


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
