// 하루 24시간.
//
// 태양 위치를 실제로 계산한다(서울 위도 37.4845, 9월 초 태양 적위 +5.2°).
// 그래서 "6시에 동쪽에서 뜨고 18시 반에 서쪽으로 진다"가 그림이 아니라 계산 결과다.
//
// 색은 밤·노을·낮 세 벌을 만들어 두고 **태양 고도**로 섞는다.
// 고도가 -9° 아래면 완전한 밤, 0~6°면 노을, 16° 위면 한낮.
// 인공조명(창문·가로등·간판·전조등)은 해가 지평선 근처로 내려올 때 켜진다.

const LAT = 37.4845 * Math.PI / 180;
const DECL = 5.2 * Math.PI / 180;      // 9월 9일경 태양 적위
const NOON = 12.5;                     // 서울(동경 127°) 기준 남중시각 ≈ 12시 30분

/** 시각(0~24) → 태양 방향과 고도(도) */
export function sunAt(hour) {
  const H = (hour - NOON) * 15 * Math.PI / 180;
  const sinAlt = Math.sin(DECL) * Math.sin(LAT) + Math.cos(DECL) * Math.cos(LAT) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  let cosAz = (Math.sin(DECL) - Math.sin(alt) * Math.sin(LAT)) / (Math.cos(alt) * Math.cos(LAT) + 1e-9);
  cosAz = Math.max(-1, Math.min(1, cosAz));
  let az = Math.acos(cosAz);                 // 북쪽 기준
  if (H > 0) az = 2 * Math.PI - az;          // 오후에는 서쪽
  const ca = Math.cos(alt);
  return {
    // 우리 좌표: x=동쪽(+), z=남쪽(+)  → 북쪽이 -z
    x: Math.sin(az) * ca,
    y: Math.sin(alt),
    z: -Math.cos(az) * ca,
    altDeg: alt * 180 / Math.PI,
  };
}

/** 해 뜨는 시각·지는 시각 (표시용) */
export function sunTimes() {
  const cosH = -Math.tan(DECL) * Math.tan(LAT);
  const H = Math.acos(Math.max(-1, Math.min(1, cosH))) * 180 / Math.PI / 15;
  return { rise: NOON - H, set: NOON + H };
}

// ── 팔레트 ──────────────────────────────────────────────
// 밤은 지금까지 맞춰 온 값 그대로. 여기 숫자만 바꾸면 분위기가 바뀐다.
const NIGHT = {
  skyTop: [0.007, 0.010, 0.024],
  skyHorizon: [0.042, 0.038, 0.048],
  glow: [0.40, 0.27, 0.16],            // 지평선 도시광 + 낮은 곳 안개 색
  key: [0.075, 0.095, 0.150],          // 달빛
  ambSky: [0.040, 0.050, 0.075],
  ambGround: [0.020, 0.019, 0.022],
  fog: [0.021, 0.026, 0.040],
  fogDensity: 0.00165,
  exposure: 0.92,
  bloom: [0.52, 0.66, 0.68],           // 강도, 반경, 문턱
  lit: 0.55,                           // 불 켜진 창문 비율
  artificial: 1.0,                     // 인공조명 세기
  disk: [1.6, 1.7, 2.0],               // 달 밝기
  diskSize: 0.99975,
  stars: 1.0,
};

const GOLDEN = {
  skyTop: [0.10, 0.15, 0.34],
  skyHorizon: [1.15, 0.55, 0.26],
  glow: [1.10, 0.58, 0.26],
  key: [1.80, 0.80, 0.36],
  ambSky: [0.26, 0.27, 0.36],
  ambGround: [0.13, 0.10, 0.085],
  fog: [0.40, 0.27, 0.24],
  fogDensity: 0.00160,
  exposure: 0.90,
  bloom: [0.36, 0.66, 0.85],
  lit: 0.34,
  artificial: 0.72,
  disk: [9.0, 5.0, 2.4],
  diskSize: 0.9994,
  stars: 0.18,
};

const DAY = {
  skyTop: [0.20, 0.42, 1.00],
  skyHorizon: [0.72, 0.86, 1.12],
  glow: [0.62, 0.70, 0.86],
  key: [3.10, 2.95, 2.72],
  ambSky: [0.80, 0.94, 1.22],
  ambGround: [0.30, 0.29, 0.27],
  fog: [0.66, 0.76, 0.92],
  fogDensity: 0.00105,
  exposure: 0.72,
  bloom: [0.12, 0.60, 1.20],
  lit: 0.03,
  artificial: 0.0,
  disk: [22.0, 21.0, 19.0],
  diskSize: 0.99965,
  stars: 0.0,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mixN = (a, b, t) => a + (b - a) * t;

/** 태양 고도(도) → 섞인 팔레트 */
export function paletteAt(altDeg) {
  // 밤 → 노을 → 낮 으로 이어지는 두 번의 전환
  const toGolden = sstep(-9, -1, altDeg);   // 밤에서 노을로
  const toDay = sstep(5, 17, altDeg);       // 노을에서 낮으로
  const a = {};
  const lerpKey = (k, fn) => {
    const g = fn(NIGHT[k], GOLDEN[k], toGolden);
    a[k] = fn(g, DAY[k], toDay);
  };
  for (const k of ['skyTop', 'skyHorizon', 'glow', 'key', 'ambSky', 'ambGround', 'fog', 'disk']) {
    lerpKey(k, mix3);
  }
  for (const k of ['fogDensity', 'exposure', 'lit', 'artificial', 'diskSize', 'stars']) {
    lerpKey(k, mixN);
  }
  a.bloom = [
    mixN(mixN(NIGHT.bloom[0], GOLDEN.bloom[0], toGolden), DAY.bloom[0], toDay),
    mixN(mixN(NIGHT.bloom[1], GOLDEN.bloom[1], toGolden), DAY.bloom[1], toDay),
    mixN(mixN(NIGHT.bloom[2], GOLDEN.bloom[2], toGolden), DAY.bloom[2], toDay),
  ];
  // 낮 밝기(간판·판때기가 햇빛을 받아 보이는 정도)
  a.dayLight = mixN(mixN(0.0, 0.22, toGolden), 1.0, toDay);
  return a;
}

/** 시각을 씬 전체에 적용한다 */
export function applyTime(hour, U, bloomPass, renderer, opts = {}) {
  const s = sunAt(hour);
  const p = paletteAt(s.altDeg);

  U.uSunDir.value.set(s.x, s.y, s.z).normalize();
  U.uSunColor.value.set(p.key[0], p.key[1], p.key[2]);
  U.uAmbSky.value.set(p.ambSky[0], p.ambSky[1], p.ambSky[2]);
  U.uAmbGround.value.set(p.ambGround[0], p.ambGround[1], p.ambGround[2]);
  U.uCityGlow.value.set(p.glow[0], p.glow[1], p.glow[2]);
  U.uFogColor.value.set(p.fog[0], p.fog[1], p.fog[2]);
  // ★ 안개 밀도는 시각마다 갈아 끼우지만, 넓은 지역(섬·시 단위)에서는
  //   그 값이 통째로 너무 진하다. 낮 팔레트 0.00105 면 3km 에서 이미 100% 다.
  //   그래서 지형 쪽에서 정한 배율(U.uFogScale)을 곱한다.
  //   이걸 안 하면 밖에서 얼마를 설정해도 여기서 매 프레임 되돌려 버린다(실제로 그랬다).
  U.uFogDensity.value = p.fogDensity * (U.uFogScale ? U.uFogScale.value : 1);
  U.uArtificial.value = p.artificial;
  U.uDayLight.value = p.dayLight;
  U.uSkyTop.value.set(p.skyTop[0], p.skyTop[1], p.skyTop[2]);
  U.uSkyHorizon.value.set(p.skyHorizon[0], p.skyHorizon[1], p.skyHorizon[2]);
  U.uDisk.value.set(p.disk[0], p.disk[1], p.disk[2]);
  U.uDiskSize.value = p.diskSize;
  U.uStars.value = p.stars;

  // 창문 밝기: 사용자가 슬라이더를 직접 건드리지 않았을 때만 시간에 맡긴다
  if (!opts.litManual) U.uLitRatio.value = p.lit;

  if (renderer) renderer.toneMappingExposure = p.exposure;
  if (bloomPass) {
    bloomPass.strength = p.bloom[0];
    bloomPass.radius = p.bloom[1];
    bloomPass.threshold = p.bloom[2];
  }
  return { sun: s, palette: p };
}

/** 12.75 → "12:45" */
export function fmtHour(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
}
