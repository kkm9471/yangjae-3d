# -*- coding: utf-8 -*-
"""간판 이름 생성기.

OSM에 이름이 있는 가게는 그 이름을 그대로 쓴다(진짜 데이터 우선).
OSM에 없는 자리는 여기서 만든 '그럴듯한' 이름으로 채운다.
실제 상표를 흉내내지 않도록 일반명사 조합만 쓴다.
결정적(deterministic) 생성: 같은 좌표/ID면 항상 같은 이름이 나온다.
"""

PREFIX = [
    "서울", "강남", "양재", "우리", "한마음", "정성", "명가", "왕가", "참", "착한",
    "원조", "황금", "미소", "하나", "새벽", "달빛", "청담", "은하", "푸른", "행복",
    "다정", "온기", "소담", "마루", "터전", "든든", "고향", "바른", "숲속", "별빛",
    "첫", "해뜰", "노을", "구름", "한결", "정직", "본가", "참맛", "손맛",
]

BY_CAT = {
    "food": ["식당", "곱창", "삼겹살", "칼국수", "국밥", "분식", "포차",
             "치킨", "족발", "보쌈", "밥상", "면옥", "횟집", "고깃집", "쌈밥", "덮밥", "돈까스"],
    "cafe": ["커피", "카페", "베이커리", "제과", "로스터리", "디저트", "브런치"],
    "bar": ["호프", "포차", "펍", "이자카야", "와인바", "맥주"],
    "beauty": ["헤어", "미용실", "헤어살롱", "네일", "뷰티", "피부관리", "왁싱", "바버샵"],
    "convenience": ["마트", "편의점", "슈퍼", "청과", "정육점"],
    "health": ["약국", "의원", "치과", "한의원", "정형외과", "피부과", "안과", "이비인후과"],
    "study": ["학원", "독서실", "스터디카페", "교습소", "어학원"],
    "shop": ["문구", "안경", "세탁", "수선", "꽃집", "완구", "가구", "조명", "철물"],
    "office": ["부동산", "공인중개사", "법무사", "세무회계", "노무법인", "설계사무소"],
    "play": ["PC방", "노래연습장", "당구장", "볼링장", "스크린골프", "코인노래방"],
    "etc": ["센터", "상사", "플라자", "타워", "빌딩", "상가"],
}

# 층이 올라갈수록 나오는 업종이 달라진다(한국 상가의 실제 층별 구성)
FLOOR_CATS = {
    1: ["food", "cafe", "convenience", "beauty", "shop", "bar"],
    2: ["food", "beauty", "health", "study", "play", "bar"],
    3: ["health", "study", "play", "office", "beauty"],
    4: ["office", "study", "health", "play"],
    5: ["office", "study", "etc"],
}

ENG = ["PLAZA", "TOWER", "OFFICE", "STUDIO", "SALON", "CLINIC", "MART", "LOUNGE",
       "GALLERY", "CENTER", "SPACE", "HOUSE", "CLUB", "LAB", "WORKS"]


def _h(seed: int, salt: int) -> int:
    """작고 빠른 결정적 해시(xorshift 계열)."""
    x = (seed * 2654435761 + salt * 40503 + 0x9E3779B9) & 0xFFFFFFFF
    x ^= (x >> 16)
    x = (x * 0x7feb352d) & 0xFFFFFFFF
    x ^= (x >> 15)
    x = (x * 0x846ca68b) & 0xFFFFFFFF
    x ^= (x >> 16)
    return x


def pick(seed: int, salt: int, arr):
    return arr[_h(seed, salt) % len(arr)]


def make_name(seed: int, floor: int = 1):
    """(이름, 분류) 를 돌려준다."""
    cats = FLOOR_CATS.get(min(floor, 5), FLOOR_CATS[5])
    cat = pick(seed, 11, cats)
    tail = pick(seed, 23, BY_CAT[cat])
    r = _h(seed, 37) % 100
    if r < 12:  # 영문 간판
        return pick(seed, 41, ENG) + " " + str(1 + _h(seed, 43) % 9), cat
    if r < 22:  # 접두사 없이 업종만
        return tail, cat
    return pick(seed, 47, PREFIX) + tail, cat


# ── OSM 태그 → 간판 분류 ──
TAG_TO_CAT = {
    "restaurant": "food", "fast_food": "food", "food_court": "food", "bbq": "food",
    "cafe": "cafe", "ice_cream": "cafe", "bakery": "cafe", "pastry": "cafe", "coffee": "cafe",
    "bar": "bar", "pub": "bar", "nightclub": "bar", "biergarten": "bar",
    "hairdresser": "beauty", "beauty": "beauty", "nail_salon": "beauty", "cosmetics": "beauty",
    "massage": "beauty", "tattoo": "beauty", "spa": "beauty",
    "convenience": "convenience", "supermarket": "convenience", "grocery": "convenience",
    "greengrocer": "convenience", "butcher": "convenience", "alcohol": "convenience",
    "variety_store": "convenience", "kiosk": "convenience", "wine": "convenience",
    "pharmacy": "health", "dentist": "health", "doctors": "health", "clinic": "health",
    "hospital": "health", "veterinary": "health", "optician": "health", "healthcare": "health",
    "school": "study", "language_school": "study", "college": "study", "university": "study",
    "library": "study", "kindergarten": "study", "driving_school": "study",
    "bank": "office", "estate_agent": "office", "insurance": "office", "lawyer": "office",
    "accountant": "office", "post_office": "office", "government": "office",
    "cinema": "play", "theatre": "play", "gym": "play", "fitness_centre": "play",
    "internet_cafe": "play", "karaoke": "play", "bowling_alley": "play",
}


def cat_of(tags: dict) -> str:
    for key in ("shop", "amenity", "office", "leisure", "healthcare", "craft", "tourism"):
        v = tags.get(key)
        if v and v in TAG_TO_CAT:
            return TAG_TO_CAT[v]
    if "shop" in tags:
        return "shop"
    if "office" in tags:
        return "office"
    if "amenity" in tags:
        return "etc"
    return "etc"


# 간판 색(야경에서 네온처럼 빛난다). [글자색, 바탕색] RGB 0~255
CAT_COLORS = {
    "food":        [(255, 244, 214), (196, 38, 30)],
    "cafe":        [(255, 250, 235), (98, 62, 40)],
    "bar":         [(255, 232, 150), (36, 30, 62)],
    "beauty":      [(255, 240, 250), (176, 42, 118)],
    "convenience": [(255, 255, 255), (24, 108, 74)],
    "health":      [(255, 255, 255), (28, 96, 168)],
    "study":       [(255, 255, 255), (32, 62, 140)],
    "shop":        [(40, 40, 44), (238, 214, 88)],
    "office":      [(226, 236, 255), (40, 52, 78)],
    "play":        [(255, 255, 255), (128, 40, 176)],
    "etc":         [(240, 240, 240), (58, 58, 66)],
}
