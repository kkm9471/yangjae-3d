// 거리의 물건들 — 가로등, 신호등, 가로수, 버스정류장, 지하철 입구.
//
// OSM에는 이 중 일부만 있다(신호등·버스정류장·지하철입구는 있고, 양재 일대에는
// 가로수가 0그루로 등록돼 있다). 없는 것은 도로 형상에서 규칙으로 만들어 세운다.
//
// 실제 광원(PointLight)은 하나도 안 쓴다. 램프는 '스스로 밝은 재질'이고,
// 바닥의 빛 웅덩이는 더하기 합성 판때기다. 이래야 수백 개를 켜도 60fps가 나온다.

import * as THREE from 'three';
import { CFG, ROAD_STYLE } from '../config.js';
import { COMMON, SCENE_PARS, SHADE, FOG_APPLY } from '../util/glsl.js';
import { h32, rnd } from '../util/rand.js';
import { offsetPolyline } from './roads.js';

// ── 색 ──
const C_POLE = [0.075, 0.077, 0.082];
const C_LAMP = [1.00, 0.80, 0.48];
const C_TRUNK = [0.055, 0.045, 0.038];
const C_LEAF = [0.026, 0.042, 0.026];
const C_SHELTER = [0.10, 0.105, 0.115];
const C_GLASS = [0.85, 0.92, 1.00];
const C_SIGNBOX = [0.06, 0.06, 0.065];

function Buf() { return { pos: [], nrm: [], col: [], idx: [], v: 0 }; }

function quad(B, a, b, c, d, n, col, e) {
  for (const p of [a, b, c, d]) { B.pos.push(p[0], p[1], p[2]); B.nrm.push(n[0], n[1], n[2]); B.col.push(col[0], col[1], col[2], e); }
  B.idx.push(B.v, B.v + 1, B.v + 2, B.v, B.v + 2, B.v + 3);
  B.v += 4;
}

/** 축정렬 상자(선택적으로 y축 회전) */
function box(B, x, y, z, w, h, d, col, e, rot = 0) {
  const hx = w / 2, hz = d / 2;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const P = (ox, oy, oz) => [x + ox * cs - oz * sn, y + oy, z + ox * sn + oz * cs];
  const c000 = P(-hx, 0, -hz), c100 = P(hx, 0, -hz), c110 = P(hx, 0, hz), c010 = P(-hx, 0, hz);
  const t000 = P(-hx, h, -hz), t100 = P(hx, h, -hz), t110 = P(hx, h, hz), t010 = P(-hx, h, hz);
  quad(B, c000, c100, t100, t000, [-sn, 0, -cs], col, e);
  quad(B, c100, c110, t110, t100, [cs, 0, -sn], col, e);
  quad(B, c110, c010, t010, t110, [sn, 0, cs], col, e);
  quad(B, c010, c000, t000, t010, [-cs, 0, sn], col, e);
  quad(B, t000, t100, t110, t010, [0, 1, 0], col, e);
  quad(B, c010, c110, c100, c000, [0, -1, 0], col, e);
}

/** 세로 원기둥(저폴리) */
function cyl(B, x, y, z, r0, r1, h, seg, col, e) {
  const start = B.v;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const cx = Math.cos(a), cz = Math.sin(a);
    B.pos.push(x + cx * r0, y, z + cz * r0); B.nrm.push(cx, 0, cz); B.col.push(col[0], col[1], col[2], e);
    B.pos.push(x + cx * r1, y + h, z + cz * r1); B.nrm.push(cx, 0, cz); B.col.push(col[0], col[1], col[2], e);
  }
  B.v += (seg + 1) * 2;
  for (let i = 0; i < seg; i++) {
    const a = start + i * 2;
    B.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

/** 저폴리 구(나뭇잎 덩어리) */
function blob(B, x, y, z, r, col, e, seed) {
  const rows = 4, cols = 6, start = B.v;
  for (let i = 0; i <= rows; i++) {
    const phi = (i / rows) * Math.PI;
    for (let j = 0; j <= cols; j++) {
      const th = (j / cols) * Math.PI * 2;
      const jitter = 0.75 + 0.5 * rnd(seed, i * 17 + j);
      const sx = Math.sin(phi) * Math.cos(th), sy = Math.cos(phi), sz = Math.sin(phi) * Math.sin(th);
      B.pos.push(x + sx * r * jitter, y + sy * r * 0.85 * jitter, z + sz * r * jitter);
      B.nrm.push(sx, sy, sz);
      B.col.push(col[0], col[1], col[2], e);
    }
  }
  B.v += (rows + 1) * (cols + 1);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = start + i * (cols + 1) + j;
      B.idx.push(a, a + cols + 1, a + 1, a + 1, a + cols + 1, a + cols + 2);
    }
  }
}

// ─────────────────── 개별 물건 ───────────────────
function streetLamp(B, pools, x, z, dirX, dirZ, seed) {
  const H = 8.2 + rnd(seed, 1) * 1.4;
  const arm = 2.2 + rnd(seed, 2) * 0.8;
  cyl(B, x, 0, z, 0.14, 0.10, H, 6, C_POLE, 0);
  // 도로 쪽으로 뻗는 팔
  const ax = x + dirX * arm * 0.5, az = z + dirZ * arm * 0.5;
  box(B, ax, H - 0.25, az, arm, 0.16, 0.16, C_POLE, 0, Math.atan2(dirZ, dirX));
  // 등 (스스로 밝다)
  box(B, x + dirX * arm, H - 0.45, z + dirZ * arm, 0.85, 0.22, 0.42, C_LAMP, 3.4, Math.atan2(dirZ, dirX));
  pools.push([x + dirX * arm, z + dirZ * arm, 11.5 + rnd(seed, 3) * 3, 1.0, 0.72, 0.42, 0.95]);
}

function trafficLight(B, pools, x, z, dirX, dirZ, seed) {
  const H = 5.0;
  cyl(B, x, 0, z, 0.13, 0.11, H, 6, C_POLE, 0);
  const arm = 3.6;
  const ang = Math.atan2(dirZ, dirX);
  box(B, x + dirX * arm * 0.5, H - 0.2, z + dirZ * arm * 0.5, arm, 0.14, 0.14, C_POLE, 0, ang);
  const hx = x + dirX * arm, hz = z + dirZ * arm;
  box(B, hx, H - 0.95, hz, 1.5, 0.5, 0.28, C_SIGNBOX, 0, ang);
  const green = rnd(seed, 9) > 0.45;
  const lampCol = green ? [0.30, 1.00, 0.45] : [1.00, 0.25, 0.20];
  const off = green ? 0.5 : -0.5;
  box(B, hx + Math.cos(ang) * off, H - 0.82, hz + Math.sin(ang) * off, 0.26, 0.26, 0.06, lampCol, 4.0, ang);
  pools.push([hx, hz, 5.5, lampCol[0], lampCol[1], lampCol[2], 0.35]);
}

function tree(B, x, z, seed) {
  // 실제 가로수(은행·플라타너스)는 수관 폭 3~4m 정도다. 크게 만들면 길을 다 덮는다.
  const h = 3.6 + rnd(seed, 11) * 2.0;
  cyl(B, x, 0, z, 0.15, 0.11, h, 5, C_TRUNK, 0);
  const r = 1.05 + rnd(seed, 12) * 0.65;
  blob(B, x, h + r * 0.5, z, r, C_LEAF, 0, seed);
  if (rnd(seed, 13) > 0.55) {
    blob(B, x + (rnd(seed, 14) - 0.5) * 1.0, h + r * 1.05, z + (rnd(seed, 15) - 0.5) * 1.0, r * 0.7, C_LEAF, 0, seed + 7);
  }
}

function busStop(B, pools, x, z, ang, seed) {
  box(B, x, 0, z, 4.6, 0.14, 1.9, [0.11, 0.11, 0.12], 0, ang);
  cyl(B, x - 2.1 * Math.cos(ang), 0, z - 2.1 * Math.sin(ang), 0.08, 0.08, 2.6, 5, C_POLE, 0);
  cyl(B, x + 2.1 * Math.cos(ang), 0, z + 2.1 * Math.sin(ang), 0.08, 0.08, 2.6, 5, C_POLE, 0);
  box(B, x, 2.6, z, 4.8, 0.14, 2.1, C_SHELTER, 0, ang);
  // 광고 패널 — 밤에 이게 제일 밝다
  const px = x + 2.0 * Math.cos(ang), pz = z + 2.0 * Math.sin(ang);
  box(B, px, 0.2, pz, 0.14, 2.2, 1.3, [0.95, 0.96, 1.0], 2.4, ang);
  // 정류장 안내 전광판
  box(B, x, 2.75, z, 3.2, 0.36, 0.12, [1.0, 0.55, 0.15], 2.0, ang);
  pools.push([x, z, 9, 1.0, 0.85, 0.6, 0.7]);
}

function subwayEntrance(B, pools, x, z, ang, seed) {
  box(B, x, 0, z, 4.2, 0.25, 3.0, [0.09, 0.09, 0.10], 0, ang);
  for (const s of [-1, 1]) {
    cyl(B, x + Math.cos(ang) * 1.9 * s, 0, z + Math.sin(ang) * 1.9 * s, 0.07, 0.07, 3.0, 5, C_POLE, 0);
  }
  box(B, x, 3.0, z, 4.4, 0.16, 3.2, [0.13, 0.13, 0.14], 0, ang);
  box(B, x, 2.2, z, 2.6, 0.6, 0.14, [1.0, 0.78, 0.20], 2.8, ang);   // 노란 역 표지
  pools.push([x, z, 10, 1.0, 0.8, 0.45, 0.8]);
}

// ─────────────────── 청크 단위 생성 ───────────────────
/**
 * @param {object} opt  { geom:true 기둥·나무 등 실물, pools:true 바닥 빛 웅덩이 }
 * 빛 웅덩이는 가벼워서 먼 청크까지 만든다. 위에서 내려다볼 때 도시가
 * 빛나 보이는 건 거의 전부 이 웅덩이 덕분이다.
 */
export function buildPropsMesh(chunk, uniforms, opt = { geom: true, pools: true }) {
  const B = Buf();
  const pools = [];
  // 청크 크기를 여기 손으로 박아 두면, config.py 에서 격자를 바꾸는 순간
  // 가로등·가로수가 조용히 90% 사라진다(실측 확인). index.json 값을 쓴다.
  const CS = CFG.chunkSize;
  const cx0 = chunk.cx * CS, cz0 = chunk.cz * CS;

  const inChunk = (x, z) => x >= cx0 && x < cx0 + CS && z >= cz0 && z < cz0 + CS;

  // ── 도로를 따라 가로등·가로수 ──
  for (const r of chunk.roads || []) {
    if (r.tunnel || r.bridge) continue;
    const sty = ROAD_STYLE[r.cls] || ROAD_STYLE.residential;
    if (sty.lampSide === 'none' && !sty.trees) continue;
    if (r.sw < 0.5) continue;
    const half = r.w / 2;
    const seed0 = h32(Math.round(r.pts[0][0] * 10), Math.round(r.pts[0][1] * 10), r.lanes);

    for (const side of [1, -1]) {
      const lampLine = offsetPolyline(r.pts, side * (half + r.sw * 0.30));
      const treeLine = offsetPolyline(r.pts, side * (half + r.sw * 0.72));
      const total = polyLen(r.pts);
      // 가로등
      if (sty.lampSide === 'both' || (sty.lampSide === 'alt' && side > 0)) {
        const step = CFG.lampSpacing;
        for (let s = step * 0.5; s < total; s += step) {
          const p = pointAt(lampLine, s); if (!p || !inChunk(p[0], p[1])) continue;
          const t = tangentAt(r.pts, s);
          // 팔이 도로 쪽(중심선 방향)을 향하게. offsetPolyline 의 법선 반대편.
          streetLamp(B, pools, p[0], p[1], side * t[1], -side * t[0],
                     h32(Math.round(p[0] * 7), Math.round(p[1] * 7), 3));
        }
      }
      // 가로수
      if (sty.trees) {
        const step = CFG.treeSpacing;
        for (let s = step * 0.75; s < total; s += step) {
          const p = pointAt(treeLine, s); if (!p || !inChunk(p[0], p[1])) continue;
          const sd = h32(Math.round(p[0] * 7), Math.round(p[1] * 7), 5);
          if (rnd(sd, 2) < 0.28) continue;               // 군데군데 빠진 자리
          tree(B, p[0], p[1], sd);
        }
      }
    }
  }

  // ── OSM 점 데이터 ──
  for (const p of chunk.props || []) {
    const sd = h32(Math.round(p.x * 7), Math.round(p.z * 7), 11);
    const near = nearestRoadDir(chunk, p.x, p.z);
    switch (p.kind) {
      case 'signal': trafficLight(B, pools, p.x, p.z, near.nx, near.nz, sd); break;
      case 'busstop': busStop(B, pools, p.x, p.z, near.ang, sd); break;
      case 'subway': subwayEntrance(B, pools, p.x, p.z, near.ang, sd); break;
      case 'lamp': streetLamp(B, pools, p.x, p.z, near.nx, near.nz, sd); break;
      case 'tree': tree(B, p.x, p.z, sd); break;
      default: break;
    }
  }

  const out = [];
  if (opt.geom && B.idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nrm, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(B.col, 4));
    g.setIndex(B.idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, propMaterial(uniforms));
    m.userData.tris = B.idx.length / 3;
    out.push(m);
  }
  if (opt.pools && pools.length) {
    const pm = buildPools(pools, uniforms);
    if (pm) out.push(pm);
  }
  if (!out.length) return null;
  const grp = new THREE.Group();
  out.forEach(o => grp.add(o));
  grp.userData.tris = out.reduce((s, o) => s + (o.userData.tris || 0), 0);
  return grp;
}

/** 바닥의 빛 웅덩이 — 더하기 합성 판때기 */
function buildPools(list, uniforms) {
  const pos = [], uv = [], col = [], idx = [];
  let v = 0;
  for (const [x, z, r, cr, cg, cb, inten] of list) {
    pos.push(x - r, 0.09, z - r, x + r, 0.09, z - r, x + r, 0.09, z + r, x - r, 0.09, z + r);
    uv.push(-1, -1, 1, -1, 1, 1, -1, 1);
    for (let i = 0; i < 4; i++) col.push(cr, cg, cb, inten);
    idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, poolMaterial(uniforms));
  m.renderOrder = 5;
  m.userData.tris = idx.length / 3;
  return m;
}

// ── 보조 ──
function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
function pointAt(line, s) {
  let acc = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const L = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    if (acc + L >= s) {
      const t = (s - acc) / (L || 1);
      return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
    }
    acc += L;
  }
  return null;
}
function tangentAt(pts, s) {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
    const L = Math.hypot(dx, dz) || 1;
    if (acc + L >= s) return [dx / L, dz / L];
    acc += L;
  }
  const n = pts.length;
  const dx = pts[n - 1][0] - pts[n - 2][0], dz = pts[n - 1][1] - pts[n - 2][1];
  const L = Math.hypot(dx, dz) || 1;
  return [dx / L, dz / L];
}
/** 이 점에서 가장 가까운 도로의 방향(설치물이 도로를 바라보게) */
function nearestRoadDir(chunk, x, z) {
  let best = null, bd = 1e9;
  for (const r of chunk.roads || []) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const dd = dx * dx + dz * dz;
      const t = dd < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / dd));
      const qx = a[0] + dx * t, qz = a[1] + dz * t;
      const d = Math.hypot(x - qx, z - qz);
      if (d < bd) { bd = d; best = { qx, qz, tx: dx, tz: dz }; }
    }
  }
  if (!best) return { nx: 1, nz: 0, ang: 0 };
  let nx = best.qx - x, nz = best.qz - z;
  const L = Math.hypot(nx, nz) || 1;
  nx /= L; nz /= L;
  const tl = Math.hypot(best.tx, best.tz) || 1;
  return { nx, nz, ang: Math.atan2(best.tz / tl, best.tx / tl) };
}

let _pm = null;
export function propMaterial(uniforms) {
  if (_pm) return _pm;
  _pm = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec4 aCol;
      varying vec4 vCol; varying vec3 vN;
      ${SCENE_PARS}
      void main(){
        vCol = aCol;
        vN = normalize(mat3(modelMatrix)*normal);
        vec4 wp = modelMatrix*vec4(position,1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix*viewMatrix*wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec4 vCol; varying vec3 vN;
      ${SCENE_PARS}
      ${COMMON}
      ${SHADE}
      void main(){
        vec3 base = vCol.rgb;
        float e = vCol.a;
        vec3 col = shadeNight(normalize(vN), base) + base*e*uArtificial;
        // 아래쪽일수록 거리 불빛을 더 받는다. 바탕색을 곱해야 나무가 갈색으로 뜨지 않는다.
        float up = exp(-max(0.0, vWorld.y-0.5)*0.10);
        col += base*vec3(1.0,0.6,0.28)*up*0.55*(1.0-min(1.0,e))*uArtificial;
        ${FOG_APPLY}
        col = mix(col, uFogColor, fogF*(1.0-0.5*min(1.0,e)));
        gl_FragColor = vec4(col,1.0);
      }`,
    side: THREE.DoubleSide,
  });
  return _pm;
}

let _pool = null;
export function poolMaterial(uniforms) {
  if (_pool) return _pool;
  _pool = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec4 aCol;
      varying vec2 vUv; varying vec4 vCol;
      ${SCENE_PARS}
      void main(){
        vUv = uv; vCol = aCol;
        vec4 wp = modelMatrix*vec4(position,1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix*viewMatrix*wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv; varying vec4 vCol;
      ${SCENE_PARS}
      ${COMMON}
      void main(){
        float d = length(vUv);
        float a = pow(max(0.0, 1.0-d), 2.6);
        // 바닥이 젖어 있으면 빛이 얼룩덜룩 번진다
        a *= 0.72 + 0.5*fbm2(vWorld.xz*0.7);
        vec3 col = vCol.rgb * a * vCol.a * 0.78 * uArtificial;
        ${FOG_APPLY}
        col *= (1.0 - fogF*0.8);
        gl_FragColor = vec4(col, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return _pool;
}
export function resetPropMaterials(){ _pm = null; _pool = null; }
