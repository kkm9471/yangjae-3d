// 건물 만들기.
//
// 핵심 아이디어: 창문·타일·간판띠를 '이미지'로 붙이지 않고 셰이더 수식으로 그린다.
// 그래서 이미지 파일이 0개다. 대신 벽면의 두 좌표(가로 몇 m, 높이 몇 m)를
// 정점에 실어 보내고, 조각셰이더가 그 위에 격자를 그린다.
//
// 멀리 있는 벽은 창문 하나가 1픽셀보다 작아져서 그대로 그리면 지글거린다(모아레).
// 그래서 화면상 크기(fwidth)를 재서, 작아지면 '평균색'으로 부드럽게 갈아탄다.
//
// 성능: 한 청크의 모든 건물을 하나의 지오메트리로 합친다 → 드로우콜 1회.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { COMMON, SCENE_PARS, SHADE, FOG_APPLY, FOOTPRINT } from '../util/glsl.js';
import { h32, rnd } from '../util/rand.js';

// 면 종류
const FACE_WALL = 0;      // 뒷골목 쪽 벽
const FACE_ROOF = 1;      // 옥상 바닥
const FACE_FRONT = 2;     // 도로에 접한 벽 (1층 상가가 여기 생긴다)
const FACE_PROP = 3;      // 옥상 구조물·난간

// 건물 유형
export const ST_SHOP = 0;   // 저층 상가
export const ST_TOWER = 1;  // 오피스·커튼월
export const ST_RESI = 2;   // 아파트·주거

export function styleOf(b) {
  const c = b.cat || 'yes';
  if (c === 'apartments' || c === 'residential' || c === 'house' || c === 'detached') {
    return b.h > 24 ? ST_RESI : ST_SHOP;
  }
  if (c === 'office' || c === 'officetel' || c === 'hotel' || b.h >= 42) return ST_TOWER;
  if (b.h >= 26) return (h32(b.seed, 5) % 3 === 0) ? ST_RESI : ST_TOWER;
  return ST_SHOP;
}

export function signedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s * 0.5;
}

/** 건물 목록 → 하나로 합친 메시 */
export function buildBuildingMesh(list, uniforms) {
  const pos = [], nrm = [], uv = [], meta = [], idx = [];
  let vbase = 0;

  const pushQuad = (p0, p1, h0, h1, n, u0, u1, m) => {
    pos.push(p0[0], h0, p0[1], p1[0], h0, p1[1], p1[0], h1, p1[1], p0[0], h1, p0[1]);
    for (let i = 0; i < 4; i++) nrm.push(n[0], n[1], n[2]);
    uv.push(u0, h0, u1, h0, u1, h1, u0, h1);
    for (let i = 0; i < 4; i++) meta.push(m[0], m[1], m[2], m[3]);
    idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
    vbase += 4;
  };

  for (const b of list) {
    let ring = b.poly;
    if (!ring || ring.length < 3) continue;
    if (signedArea(ring) < 0) ring = ring.slice().reverse();
    const holes = (b.holes || []).map(hr => (signedArea(hr) > 0 ? hr.slice().reverse() : hr));

    const st = styleOf(b);
    // ★ seed 는 반드시 작아야 한다.
    // 큰 수(수만)를 정점속성으로 보내면 삼각형 보간 오차가 hash 안의 fract()에서
    // 수백 배로 증폭돼, 창문 불빛 판정이 픽셀마다 흔들린다(소금·후추 노이즈).
    // 실제로 그 증상을 겪고 여기까지 좁혔다. 0~1023 이면 float 로 정확히 표현된다.
    const seedF = b.seed % 1024;
    const floors = Math.max(1, Math.round((b.h - CFG.groundFloorH) / CFG.floorH) + 1);
    const parapet = st === ST_TOWER ? 0.4 : 0.95;
    const roofY = b.h;
    const topY = b.h + parapet;
    const front = new Set(b.front || []);

    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], c = ring[(i + 1) % n];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const L = Math.hypot(dx, dz);
      if (L < 0.05) continue;
      const nx = dz / L, nz = -dx / L;             // 반시계 링의 바깥 법선
      const face = front.has(i) ? FACE_FRONT : FACE_WALL;
      pushQuad(a, c, b.minh || 0, topY, [nx, 0, nz], 0, L, [seedF, face, floors, st]);
      pushQuad(c, a, roofY, topY, [-nx, 0, -nz], 0, L, [seedF, FACE_PROP, floors, st]);
    }

    // ── 옥상 ──
    try {
      const contour = ring.map(p => new THREE.Vector2(p[0], p[1]));
      const holeV = holes.map(hr => hr.map(p => new THREE.Vector2(p[0], p[1])));
      const faces = THREE.ShapeUtils.triangulateShape(contour, holeV);
      const all = contour.concat(...holeV);
      const start = vbase;
      for (const v of all) {
        pos.push(v.x, roofY, v.y);
        nrm.push(0, 1, 0);
        uv.push(v.x, v.y);
        meta.push(seedF, FACE_ROOF, floors, st);
      }
      vbase += all.length;
      for (const f of faces) {
        const A = all[f[0]], B = all[f[1]], C = all[f[2]];
        const cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
        if (cr > 0) idx.push(start + f[0], start + f[2], start + f[1]);
        else idx.push(start + f[0], start + f[1], start + f[2]);
      }
    } catch (e) { /* 자기교차 폴리곤은 옥상 생략 */ }

    // ── 옥상 구조물 ──
    if (b.h > 9 && b.area > 60) {
      const cx = ring.reduce((s, p) => s + p[0], 0) / n;
      const cz = ring.reduce((s, p) => s + p[1], 0) / n;
      const cnt = 1 + (h32(seedF, 31) % 3);
      const box = { pos, nrm, uv, meta, idx };
      for (let k = 0; k < cnt; k++) {
        const ang = rnd(seedF, 40 + k) * Math.PI * 2;
        const rad = 1.5 + rnd(seedF, 50 + k) * Math.sqrt(b.area) * 0.16;
        const bx = cx + Math.cos(ang) * rad, bz = cz + Math.sin(ang) * rad;
        const w = 0.9 + rnd(seedF, 60 + k) * 2.2, d = 0.9 + rnd(seedF, 70 + k) * 2.0;
        const hh = 0.8 + rnd(seedF, 80 + k) * 2.2;
        vbase = addBox(box, vbase, bx, roofY, bz, w, hh, d, [seedF, FACE_PROP, floors, st]);
      }
    }
  }

  if (idx.length === 0) return null;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aMeta', new THREE.Float32BufferAttribute(meta, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();

  const mesh = new THREE.Mesh(g, buildingMaterial(uniforms));
  mesh.userData.tris = idx.length / 3;
  return mesh;
}

export function addBox(B, v, x, y, z, w, h, d, m) {
  const hx = w / 2, hz = d / 2;
  const c = [[x - hx, z - hz], [x + hx, z - hz], [x + hx, z + hz], [x - hx, z + hz]];
  const quad = (p0, p1, y0, y1, n, u1) => {
    B.pos.push(p0[0], y0, p0[1], p1[0], y0, p1[1], p1[0], y1, p1[1], p0[0], y1, p0[1]);
    for (let i = 0; i < 4; i++) B.nrm.push(n[0], n[1], n[2]);
    B.uv.push(0, y0, u1, y0, u1, y1, 0, y1);
    for (let i = 0; i < 4; i++) B.meta.push(m[0], m[1], m[2], m[3]);
    B.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };
  quad(c[0], c[1], y, y + h, [0, 0, -1], w);
  quad(c[1], c[2], y, y + h, [1, 0, 0], d);
  quad(c[2], c[3], y, y + h, [0, 0, 1], w);
  quad(c[3], c[0], y, y + h, [-1, 0, 0], d);
  B.pos.push(c[0][0], y + h, c[0][1], c[1][0], y + h, c[1][1], c[2][0], y + h, c[2][1], c[3][0], y + h, c[3][1]);
  for (let i = 0; i < 4; i++) B.nrm.push(0, 1, 0);
  B.uv.push(c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]);
  for (let i = 0; i < 4; i++) B.meta.push(m[0], m[1], m[2], m[3]);
  B.idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
  return v + 4;
}

let _mat = null;
export function buildingMaterial(uniforms) {
  if (_mat) return _mat;
  _mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec4 aMeta;
      varying vec2 vUv; varying vec3 vN; varying vec4 vMeta;
      ${SCENE_PARS}
      void main(){
        vUv = uv; vMeta = aMeta;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position,1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv; varying vec3 vN; varying vec4 vMeta;
      ${SCENE_PARS}
      uniform float uLitRatio;
      uniform float uFloorH, uGroundFloorH;
      ${COMMON}
      ${SHADE}
      ${FOOTPRINT}

      vec3 wallBase(float style, float seed){
        float t = hash11(seed*0.0181+3.1);
        if(style > 1.5)  return mix(vec3(0.150,0.145,0.138), vec3(0.112,0.116,0.124), t);
        if(style > 0.5)  return mix(vec3(0.050,0.060,0.080), vec3(0.068,0.072,0.084), t);
        return mix(vec3(0.132,0.122,0.110), vec3(0.098,0.102,0.110), t);
      }

      void main(){
        float seed   = vMeta.x;
        float face   = vMeta.y;
        float style  = vMeta.w;
        float u = vUv.x, v = vUv.y;

        // 이 화소가 벽면에서 몇 m를 덮는가 → 무늬를 그릴지 평균색으로 갈지 판단
        float px = pixelFootprint(vWorld, vN);

        vec3 base = wallBase(style, seed);
        vec3 emis = vec3(0.0);

        if(face > 0.5 && face < 1.5){
          // ── 옥상 바닥 ──
          base = vec3(0.082,0.082,0.086) * (0.8 + 0.45*fbm2(vUv*0.35 + seed*0.29));
          base = mix(base, vec3(0.062,0.063,0.067), step(0.55, noise2(vUv*0.12+seed*0.37))*0.6);
        }
        else if(face > 2.5){
          // ── 난간·옥상 구조물 ──
          base = mix(vec3(0.098,0.098,0.103), vec3(0.135,0.133,0.130), hash11(seed*0.0313+floor(u*0.7)));
        }
        else {
          bool isFront = (face > 1.5);
          float fi, fy;
          if(v < uGroundFloorH){ fi = 0.0; fy = v/uGroundFloorH; }
          else { float t = (v-uGroundFloorH)/uFloorH; fi = 1.0+floor(t); fy = fract(t); }

          if(fi < 0.5 && isFront){
            // ── 1층 상가 ──
            float cell = 4.4 + hash11(seed*0.0431)*2.6;
            float ci = floor(u/cell), cu = fract(u/cell);
            float sharp = box2(vec2(cu, fy), vec2(0.09,0.12), vec2(0.91,0.76));
            // 유리 사이 기둥(멀리서 사라지면 통유리로 보이므로 평균으로)
            float res = clamp(1.0 - px/(cell*0.40), 0.0, 1.0);
            float win = mix(0.60, sharp, res);
            float open = step(hash12(vec2(ci*1.7+seed*0.53, 7.0)), 0.90);
            vec3 shopCol = mix(vec3(1.00,0.80,0.50), vec3(0.86,0.93,1.00),
                               step(0.66, hash12(vec2(ci*3.1+seed*0.29, 2.0))));
            float bright = 0.70 + 0.55*hash12(vec2(ci*2.3+seed*0.17, 5.0));
            emis += shopCol * win * open * bright * 0.62 * uArtificial;
            base = mix(base*0.5, vec3(0.020,0.020,0.024), win);
            float shut = (1.0-open)*win;
            base = mix(base, vec3(0.085,0.083,0.078)*(0.8+0.4*fract(u*2.0)), shut);
          }
          else if(fi < 0.5){
            base *= 0.70;
          }
          else {
            // ── 2층 이상 창문 격자 ──
            float colW, wl, wr, wb, wt, litBias, gain;
            vec3 litWarm, litCool;
            if(style > 1.5){                       // 아파트
              colW = 3.15 + hash11(seed*0.0537)*0.9;
              wl=0.17; wr=0.83; wb=0.24; wt=0.86; litBias=0.90; gain=0.95;
              litWarm = vec3(1.00,0.76,0.45); litCool = vec3(0.70,0.85,1.00);
            } else if(style > 0.5){                // 커튼월
              colW = 1.60 + hash11(seed*0.0619)*0.7;
              wl=0.07; wr=0.93; wb=0.12; wt=0.93; litBias=0.50; gain=0.80;
              litWarm = vec3(0.95,0.93,0.84); litCool = vec3(0.78,0.88,1.00);
            } else {                                // 저층 상가
              colW = 2.40 + hash11(seed*0.0727)*1.3;
              wl=0.15; wr=0.85; wb=0.20; wt=0.84; litBias=0.85; gain=1.00;
              litWarm = vec3(1.00,0.81,0.50); litCool = vec3(0.85,0.92,1.00);
            }
            float cov = (wr-wl)*(wt-wb);            // 창이 벽에서 차지하는 비율
            float ci = floor(u/colW), cu = fract(u/colW);
            float sharpWin = box2(vec2(cu, fy), vec2(wl,wb), vec2(wr,wt));

            float r = hash12(vec2(ci*7.13 + seed*0.0911, fi*3.71 + seed*0.0431));
            float ratio = uLitRatio*litBias;
            float sharpLit = step(r, ratio);
            float flick = step(0.985, r) * step(0.5, fract(uTime*0.13 + r*37.0));
            sharpLit = max(sharpLit*(1.0-step(0.985,r)), flick);

            // 세밀도 2단계.
            //   가까이 : 창 하나하나
            //   중간   : 창 4열×3층 묶음(구역마다 밝기가 다르다)
            //   멀리   : 완전 평균
            // 한 번에 평균으로 가면 멀리서 '회색 판자'가 되어버린다.
            float resA = clamp(1.0 - px/(colW*0.42), 0.0, 1.0);
            float bw = colW*4.0, bh = uFloorH*3.0;
            float bi = floor(u/bw), bj = floor(v/bh);
            float blk = hash12(vec2(bi*3.31 + seed*0.0673, bj*5.77 + seed*0.1013));
            float resB = clamp(1.0 - px/(bw*0.35), 0.0, 1.0);

            // 멀리서도 '어떤 구역은 환하고 어떤 구역은 껌껌한' 대비가 남아야
            // 도시가 회색 판자처럼 보이지 않는다
            float litFar = ratio*(0.12 + 2.30*blk*blk);
            float lit = mix(mix(ratio, litFar, resB), sharpLit, resA);
            float win = mix(cov, sharpWin, resA);

            // 낮에는 유리가 하늘을 비춘다
            vec3 glass = mix(vec3(0.032,0.042,0.066), uSkyHorizon*0.30 + vec3(0.02,0.03,0.05), uDayLight);
            base = mix(base, glass, win*0.9);
            float slab = smoothstep(0.0,0.055,fy)*smoothstep(0.0,0.055,1.0-fy);
            base *= mix(mix(0.86,1.0,cov), mix(0.72,1.0,slab), resA);

            float warm = step(0.30, hash12(vec2(ci*1.9+seed*0.1531, fi*2.3)));
            vec3 lc = mix(litCool, litWarm, mix(0.72, warm, resA));
            float vary = mix(0.9, 0.65 + 0.5*hash12(vec2(ci*5.1+seed*0.0817, fi*1.3+11.0)), resA);
            emis += lc * win * lit * vary * gain * 0.58 * mix(0.72, 1.0, resA) * uArtificial;
          }

          base *= 0.88 + 0.24*fbm2(vec2(u*0.28, v*0.22) + seed*0.23);

          // 길바닥·간판에서 튀어 오르는 빛 — 아래층일수록 따뜻하게 밝다.
          // 이게 없으면 건물이 '까만 상자에 창문만 뚫린 것'처럼 보인다.
          float bounce = exp(-max(0.0, v-1.0)*0.09);
          base += vec3(1.00,0.60,0.28) * bounce * (isFront ? 0.075 : 0.030) * uArtificial;
        }

        vec3 col = shadeNight(normalize(vN), base) + emis;
        ${FOG_APPLY}
        float ef = clamp(dot(emis, vec3(0.4)), 0.0, 1.0);
        col = mix(col, uFogColor, fogF*(1.0 - 0.45*ef));
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.FrontSide,
  });
  return _mat;
}

export function resetBuildingMaterial() { _mat = null; }
