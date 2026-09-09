// 화면 연출에 쓰는 값들. 숫자를 바꾸면 바로 화면이 달라진다.
// (세계의 '사실'인 좌표·건물 높이는 여기 없다 — 그건 data/ 안에 있다)

export const CFG = {
  // ── 범위 ──
  viewRadius: 300,          // 청크를 로드할 반경(m). HUD 슬라이더로 조절.
  chunkKeepMargin: 120,     // 반경 밖이라도 이만큼은 유지(경계에서 깜빡임 방지)
  chunkSize: 100,           // ★ 시작할 때 index.json 값으로 덮어씀 (여기 값은 기본값일 뿐)

  // ── 건물 ──
  floorH: 3.35,             // 기준 층고(m) — build_scene.py 와 같은 값이어야 한다
  groundFloorH: 4.3,        // 1층 층고(m)
  litRatio: 0.55,           // 불 켜진 창문 비율

  // ── 안개(도시의 밤 스모그) ──
  fogColor: [0.021, 0.026, 0.040],
  fogDensity: 0.00165,

  // ── 하늘·달빛 ──
  skyTop: [0.007, 0.010, 0.024],
  skyHorizon: [0.042, 0.038, 0.048],
  cityGlow: [0.40, 0.27, 0.16],   // 지평선 도시 불빛 번짐
  moonDir: [0.35, 0.72, -0.60],
  moonColor: [0.075, 0.095, 0.150],
  ambSky: [0.040, 0.050, 0.075],
  ambGround: [0.020, 0.019, 0.022],

  // ── 연출 밀도 ──
  signDensity: 1.0,
  treeSpacing: 15,          // 가로수 간격(m)
  lampSpacing: 26,          // 가로등 간격(m)
  peoplePerKm: 260,         // 보도 1km당 보행자 수(큰길 기준, 골목은 절반 이하)
  carsPerKm: 34,            // 차로 1km당 차량 수
  maxPeoplePerChunk: 150,
  maxCars: 420,

  // ── 후처리 ──
  bloom: { strength: 0.52, radius: 0.66, threshold: 0.68 },
  exposure: 0.92,

  // ── 카메라 ──
  eyeHeight: 1.68,
  walkSpeed: 3.6,
  runSpeed: 9.0,
  flySpeed: 26,
};

// 도로 등급별 색·표시 규칙
export const ROAD_STYLE = {
  motorway:     { asphalt: 0x14161b, center: 'none',   lampSide: 'both', trees: false },
  trunk:        { asphalt: 0x15171c, center: 'yellow2', lampSide: 'both', trees: true },
  primary:      { asphalt: 0x16181d, center: 'yellow2', lampSide: 'both', trees: true },
  secondary:    { asphalt: 0x15171b, center: 'yellow1', lampSide: 'both', trees: true },
  tertiary:     { asphalt: 0x141619, center: 'yellow1', lampSide: 'alt',  trees: true },
  unclassified: { asphalt: 0x131518, center: 'none',    lampSide: 'alt',  trees: false },
  residential:  { asphalt: 0x131518, center: 'none',    lampSide: 'alt',  trees: false },
  living_street:{ asphalt: 0x141518, center: 'none',    lampSide: 'alt',  trees: false },
  busway:       { asphalt: 0x1a1418, center: 'none',    lampSide: 'none', trees: false },
  service:      { asphalt: 0x121316, center: 'none',    lampSide: 'none', trees: false },
  pedestrian:   { asphalt: 0x1b1a1c, center: 'none',    lampSide: 'alt',  trees: true },
  track:        { asphalt: 0x121316, center: 'none',    lampSide: 'none', trees: false },
};

// 간판 분류별 색 [글자, 바탕] — names.py 의 CAT_COLORS 와 짝을 이룬다
export const SIGN_COLORS = {
  food:        [[1.00, 0.96, 0.84], [0.77, 0.15, 0.12]],
  cafe:        [[1.00, 0.98, 0.92], [0.38, 0.24, 0.16]],
  bar:         [[1.00, 0.91, 0.59], [0.14, 0.12, 0.24]],
  beauty:      [[1.00, 0.94, 0.98], [0.69, 0.16, 0.46]],
  convenience: [[1.00, 1.00, 1.00], [0.09, 0.42, 0.29]],
  health:      [[1.00, 1.00, 1.00], [0.11, 0.38, 0.66]],
  study:       [[1.00, 1.00, 1.00], [0.13, 0.24, 0.55]],
  shop:        [[0.16, 0.16, 0.17], [0.93, 0.84, 0.35]],
  office:      [[0.89, 0.93, 1.00], [0.16, 0.20, 0.31]],
  play:        [[1.00, 1.00, 1.00], [0.50, 0.16, 0.69]],
  etc:         [[0.94, 0.94, 0.94], [0.23, 0.23, 0.26]],
};
