// 간판 이름 만들기 (tools/names.py 의 웹 버전).
// OSM에 이름이 있으면 그 이름을 쓰고, 없는 자리만 여기서 만든다.
// 실제 상표를 흉내내지 않도록 일반명사 조합만 쓴다.

import { h32 } from '../util/rand.js';

const PREFIX = [
  '서울', '강남', '양재', '우리', '한마음', '정성', '명가', '왕가', '참', '착한',
  '원조', '황금', '미소', '하나', '새벽', '달빛', '청담', '은하', '푸른', '행복',
  '다정', '온기', '소담', '마루', '터전', '든든', '고향', '바른', '숲속', '별빛',
  '첫', '해뜰', '노을', '구름', '한결', '정직', '본가', '참맛', '손맛', '늘봄',
];

const BY_CAT = {
  food: ['식당', '곱창', '삼겹살', '칼국수', '국밥', '분식', '포차', '치킨', '족발',
         '보쌈', '밥상', '면옥', '횟집', '고깃집', '쌈밥', '덮밥', '돈까스', '냉면'],
  cafe: ['커피', '카페', '베이커리', '제과', '로스터리', '디저트', '브런치'],
  bar: ['호프', '포차', '펍', '이자카야', '와인바', '맥주'],
  beauty: ['헤어', '미용실', '헤어살롱', '네일', '뷰티', '피부관리', '왁싱', '바버샵'],
  convenience: ['마트', '편의점', '슈퍼', '청과', '정육점'],
  health: ['약국', '의원', '치과', '한의원', '정형외과', '피부과', '안과', '이비인후과'],
  study: ['학원', '독서실', '스터디카페', '교습소', '어학원'],
  shop: ['문구', '안경', '세탁', '수선', '꽃집', '완구', '가구', '조명', '철물'],
  office: ['부동산', '공인중개사', '법무사', '세무회계', '노무법인', '설계사무소'],
  play: ['PC방', '노래연습장', '당구장', '볼링장', '스크린골프', '코인노래방'],
  etc: ['센터', '상사', '플라자', '타워', '빌딩', '상가'],
};

const FLOOR_CATS = {
  1: ['food', 'cafe', 'convenience', 'beauty', 'shop', 'bar'],
  2: ['food', 'beauty', 'health', 'study', 'play', 'bar'],
  3: ['health', 'study', 'play', 'office', 'beauty'],
  4: ['office', 'study', 'health', 'play'],
  5: ['office', 'study', 'etc'],
};

const ENG = ['PLAZA', 'TOWER', 'OFFICE', 'STUDIO', 'SALON', 'CLINIC', 'MART', 'LOUNGE',
             'GALLERY', 'CENTER', 'SPACE', 'HOUSE', 'CLUB', 'LAB', 'WORKS'];

function pick(arr, seed, salt) { return arr[h32(seed, salt) % arr.length]; }

/** (이름, 분류) */
export function makeName(seed, floor) {
  const cats = FLOOR_CATS[Math.min(Math.max(1, floor), 5)] || FLOOR_CATS[5];
  const cat = pick(cats, seed, 11);
  const tail = pick(BY_CAT[cat], seed, 23);
  const r = h32(seed, 37) % 100;
  if (r < 11) return [pick(ENG, seed, 41) + ' ' + (1 + h32(seed, 43) % 9), cat];
  if (r < 21) return [tail, cat];
  return [pick(PREFIX, seed, 47) + tail, cat];
}
