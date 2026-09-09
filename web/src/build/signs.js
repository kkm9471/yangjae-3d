// 간판.
//
// 폰트 파일을 하나도 안 쓴다. 브라우저에 이미 깔린 시스템 글꼴로 캔버스에 글자를 그려
// 하나의 큰 '아틀라스' 그림을 만들고, 그 조각을 판때기에 붙인다.
// (그림 파일을 배포하는 게 아니라, 실행할 때 코드가 그린다)
//
// 이름은 OSM에 등록된 실제 상호를 먼저 쓰고, 남는 자리만 만들어 채운다.

import * as THREE from 'three';
import { CFG, SIGN_COLORS } from '../config.js';
import { SCENE_PARS, COMMON, FOG_APPLY } from '../util/glsl.js';
import { h32, rnd } from '../util/rand.js';
import { makeName } from './names.js';
import { signedArea, styleOf, ST_SHOP, ST_TOWER, ST_RESI } from './buildings.js';

// ── 아틀라스 ──
// 위쪽 1536px: 가로 간판 칸(128×32) 32×48 = 1,536
// 아래쪽 512px: 세로 간판 칸(32×128) 128×4 = 512
// (첫 화면에서만 이름이 1,300개 넘게 나오므로 512칸으로는 모자랐다)
const AT_W = 4096, AT_H = 2048;
const H_ZONE_H = 1536;
const HCELL_W = 128, HCELL_H = 32, HCOLS = AT_W / HCELL_W, HROWS = H_ZONE_H / HCELL_H;
const VCELL_W = 32, VCELL_H = 128, VCOLS = AT_W / VCELL_W, VROWS = (AT_H - H_ZONE_H) / VCELL_H;

/** 문자열 → 작은 정수 (칸이 다 찼을 때 어떤 이름을 재사용할지 고르는 용도) */
function strHash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

const KFONT = '"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif';

class Atlas {
  constructor() {
    this.cv = document.createElement('canvas');
    this.cv.width = AT_W; this.cv.height = AT_H;
    this.ctx = this.cv.getContext('2d', { willReadFrequently: false });
    this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, AT_W, AT_H);
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    // 밉맵을 만들면 아틀라스의 옆 칸 글자와 섞여 흰 판때기가 된다 → 끈다
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.map = new Map();
    this.hRects = [];      // 이미 그린 가로 간판 칸들
    this.vRects = [];      // 이미 그린 세로 간판 칸들
    this.overflow = 0;     // 칸이 모자라 이름을 돌려 쓴 횟수
    this.dirty = false;
  }

  /** 이름+분류+방향 → 아틀라스 안의 uv 사각형 */
  get(name, cat, vertical) {
    const key = `${vertical ? 'V' : 'H'}|${cat}|${name}`;
    const hit = this.map.get(key);
    if (hit) return hit;

    const list = vertical ? this.vRects : this.hRects;
    const cap = vertical ? VCOLS * VROWS : HCOLS * HROWS;

    // ★ 칸이 다 찼을 때 새 칸을 만들면 안 된다.
    //   이미 세워진 간판 판때기는 그 칸의 좌표를 그대로 물고 있어서,
    //   그 칸에 다른 이름을 덮어 그리면 '미용실 간판에 철물점 이름'이 뜬다.
    //   화면만 봐서는 절대 못 잡는 종류의 사고라, 아예 덮어쓰지 않는다.
    //   대신 이미 그려 둔 이름 하나를 돌려 쓴다 — 이름이 몇 개 겹쳐 보일 뿐이다.
    if (list.length >= cap) {
      if (!list.length) return { u0: 0, v0: 0, u1: 0, v1: 0 };
      this.overflow++;
      const reuse = list[strHash(key) % list.length];
      this.map.set(key, reuse);
      return reuse;
    }

    const r = vertical ? this._drawV(name, cat, list.length) : this._drawH(name, cat, list.length);
    list.push(r);
    this.map.set(key, r);
    this.dirty = true;
    return r;
  }

  _drawH(name, cat, i) {
    const x = (i % HCOLS) * HCELL_W, y = ((i / HCOLS) | 0) * HCELL_H;
    const [fg, bg] = SIGN_COLORS[cat] || SIGN_COLORS.etc;
    const c = this.ctx;
    c.save();
    c.beginPath(); c.rect(x, y, HCELL_W, HCELL_H); c.clip();
    c.fillStyle = rgb(bg); c.fillRect(x, y, HCELL_W, HCELL_H);
    c.strokeStyle = rgb(mul(fg, 0.5)); c.lineWidth = 2;
    c.strokeRect(x + 1, y + 1, HCELL_W - 2, HCELL_H - 2);
    let size = 22;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (; size > 9; size--) {
      c.font = `700 ${size}px ${KFONT}`;
      if (c.measureText(name).width <= HCELL_W - 12) break;
    }
    c.fillStyle = rgb(fg);
    c.fillText(name, x + HCELL_W / 2, y + HCELL_H / 2 + 1, HCELL_W - 8);
    c.restore();
    return uvRect(x, y, HCELL_W, HCELL_H);
  }

  _drawV(name, cat, i) {
    const x = (i % VCOLS) * VCELL_W, y = H_ZONE_H + ((i / VCOLS) | 0) * VCELL_H;
    const [fg, bg] = SIGN_COLORS[cat] || SIGN_COLORS.etc;
    const c = this.ctx;
    c.save();
    c.beginPath(); c.rect(x, y, VCELL_W, VCELL_H); c.clip();
    c.fillStyle = rgb(bg); c.fillRect(x, y, VCELL_W, VCELL_H);
    c.strokeStyle = rgb(mul(fg, 0.5)); c.lineWidth = 2;
    c.strokeRect(x + 1, y + 1, VCELL_W - 2, VCELL_H - 2);
    // 글자를 세로로 쌓는다(한국 세로 간판 방식)
    const chars = [...name].slice(0, 6);
    const cell = Math.min(24, (VCELL_H - 8) / chars.length);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `700 ${Math.floor(cell * 0.92)}px ${KFONT}`;
    c.fillStyle = rgb(fg);
    const top = y + (VCELL_H - cell * chars.length) / 2 + cell / 2;
    chars.forEach((ch, i) => c.fillText(ch, x + VCELL_W / 2, top + i * cell, VCELL_W - 4));
    c.restore();
    return uvRect(x, y, VCELL_W, VCELL_H);
  }
}

function rgb(a) { return `rgb(${Math.round(a[0] * 255)},${Math.round(a[1] * 255)},${Math.round(a[2] * 255)})`; }
function mul(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function uvRect(x, y, w, h) {
  // canvas y축은 아래로, 텍스처 v축은 위로 → 뒤집어 준다
  return { u0: x / AT_W, v0: 1 - (y + h) / AT_H, u1: (x + w) / AT_W, v1: 1 - y / AT_H };
}

let _atlas = null;
export function atlas() { if (!_atlas) _atlas = new Atlas(); return _atlas; }

// ────────────────────────── 간판 배치 ──────────────────────────
export function buildSignMesh(chunk, uniforms) {
  const A = atlas();
  const pos = [], uv = [], nrm = [], ext = [], idx = [];
  let v = 0;
  let count = 0;

  const quad = (p, right, up, w, h, r, glow) => {
    // p = 좌하단 기준점, right/up = 단위벡터
    const a = [p[0], p[1], p[2]];
    const b = [p[0] + right[0] * w, p[1] + right[1] * w, p[2] + right[2] * w];
    const c = [b[0] + up[0] * h, b[1] + up[1] * h, b[2] + up[2] * h];
    const d = [a[0] + up[0] * h, a[1] + up[1] * h, a[2] + up[2] * h];
    const n = [right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]];
    pos.push(...a, ...b, ...c, ...d);
    uv.push(r.u0, r.v0, r.u1, r.v0, r.u1, r.v1, r.u0, r.v1);
    for (let i = 0; i < 4; i++) { nrm.push(n[0], n[1], n[2]); ext.push(glow); }
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
    count++;
  };

  for (const b of chunk.buildings || []) {
    if (!b.front || !b.front.length) continue;
    // poly 는 파이썬에서 반시계로 정규화해 두었고, front 인덱스는 그 순서 기준이다.
    // 혹시 뒤집힌 게 섞여 있어도 법선만 뒤집으면 되도록 부호를 계산해 둔다.
    const ring = b.poly;
    const front = b.front;
    const sgn = signedArea(ring) < 0 ? -1 : 1;
    const n = ring.length;
    const seed = b.seed % 100000;
    const floors = Math.max(1, Math.round((b.h - CFG.groundFloorH) / CFG.floorH) + 1);
    const pois = (b.pois || []).slice();
    let pi = 0;

    // 유형별 간판 규칙 (아파트 외벽에 상가 간판이 도배되면 안 된다)
    const st = styleOf(b);
    let topFloor, skipProb, allowVertical;
    if (st === ST_TOWER)      { topFloor = 2; skipProb = 0.55; allowVertical = false; }
    else if (st === ST_RESI)  { topFloor = 1; skipProb = 0.62; allowVertical = false; }
    else                      { topFloor = Math.min(floors, 5); skipProb = 0.0; allowVertical = true; }

    for (const ei of front) {
      const a = ring[ei], c2 = ring[(ei + 1) % n];
      const dx = c2[0] - a[0], dz = c2[1] - a[1];
      const L = Math.hypot(dx, dz);
      if (L < 3.0) continue;
      const tx = dx / L, tz = dz / L;
      const nx = tz * sgn, nz = -tx * sgn;           // 바깥 법선
      const right = [tx, 0, tz], up = [0, 1, 0];
      const off = 0.14;

      // 층별 가로 간판
      const maxF = Math.min(floors, topFloor);
      for (let f = 1; f <= maxF; f++) {
        const yTop = f === 1 ? CFG.groundFloorH : CFG.groundFloorH + (f - 1) * CFG.floorH;
        const bandH = f === 1 ? 1.15 : 0.92;
        const yBase = yTop - bandH - 0.18;
        if (yBase < 2.2) continue;
        let s = 0.5 + rnd(seed, ei * 31 + f) * 1.2;
        while (s < L - 2.2) {
          const wSign = Math.min(L - s - 0.4, 2.6 + rnd(seed, ei * 71 + f * 13 + (s * 10 | 0)) * 3.8);
          if (wSign < 1.6) break;
          const sd = h32(seed, ei * 101 + f * 17 + (s * 10 | 0));
          const skip = Math.max(skipProb, f === 1 ? 0.06 : 0.30);
          if (rnd(sd, 3) < skip) { s += wSign + 0.5; continue; }
          let name, cat;
          if (pi < pois.length && rnd(sd, 4) < 0.75) { name = pois[pi].n; cat = pois[pi].c; pi++; }
          else [name, cat] = makeName(sd, f);
          const r = A.get(name, cat, false);
          const px = a[0] + tx * s + nx * off, pz = a[1] + tz * s + nz * off;
          quad([px, yBase, pz], right, up, wSign, bandH, r, 1.0);
          s += wSign + 0.25 + rnd(sd, 5) * 0.7;
          if (count > 900) break;
        }
        if (count > 900) break;
      }

      // ── 옥상 네임사인 ──
      // 실제 이름이 있는 큰 건물은 옥상에 간판이 서 있다. 서울 야경에서
      // "저게 무슨 건물이지"를 바로 알게 해 주는 게 대개 이것이다.
      if (b.lm && b.name && L > 9 && ei === front[0]) {
        const nm = b.name.split(' (')[0].split('(')[0].trim().slice(0, 12);
        const r = A.get(nm, 'office', false);
        const wS = Math.min(L * 0.78, 17);
        const hS = Math.max(2.0, Math.min(3.4, wS * 0.19));
        const yb = b.h + 0.7;                       // 옥상 난간 위에 세운다
        const bx = a[0] + tx * (L - wS) / 2, bz = a[1] + tz * (L - wS) / 2;
        // 앞뒤 두 면 (양쪽에서 다 보이게)
        quad([bx, yb, bz], right, up, wS, hS, r, 1.35);
        quad([bx + tx * wS, yb, bz + tz * wS], [-tx, 0, -tz], up, wS, hS, r, 1.35);
        // 받침 기둥 두 개 대신 얇은 띠 하나(폴리곤 절약)
        quad([bx, b.h + 0.05, bz], right, up, wS, 0.65, r, 0.35);
      } else if (st === ST_TOWER && b.name && L > 8 && ei === front[0]) {
        // 이름은 있지만 낮은 건물은 벽면 상단에 띠로
        const r = A.get(b.name.split(' (')[0].slice(0, 12), 'office', false);
        const wS = Math.min(L * 0.7, 11);
        const yb = b.h - 3.4;
        quad([a[0] + tx * (L - wS) / 2 + nx * off, yb, a[1] + tz * (L - wS) / 2 + nz * off],
             right, up, wS, 1.7, r, 1.25);
      }

      // 모서리 세로 간판 (한국 상가의 특징)
      if (allowVertical && floors >= 3 && L > 7 && rnd(seed, ei * 7 + 3) < 0.55) {
        const sd = h32(seed, ei * 211 + 9);
        let name, cat;
        if (pi < pois.length) { name = pois[pi].n; cat = pois[pi].c; pi++; }
        else [name, cat] = makeName(sd, 2 + (h32(sd, 1) % 3));
        const r = A.get(name, cat, true);
        const hh = Math.min(3.0 + rnd(sd, 2) * 4.0, CFG.groundFloorH + (floors - 1) * CFG.floorH - 5.5);
        if (hh > 2.0) {
          const s0 = 0.6 + rnd(sd, 6) * (L - 2.0);
          const stick = 0.55;
          const px = a[0] + tx * s0 + nx * stick, pz = a[1] + tz * s0 + nz * stick;
          const yb = CFG.groundFloorH + 0.6;
          const wSign = 0.85;
          // 앞뒤 두 면(길 양쪽에서 다 보인다)
          quad([px - tx * wSign / 2, yb, pz - tz * wSign / 2], right, up, wSign, hh, r, 1.15);
          quad([px + tx * wSign / 2, yb, pz + tz * wSign / 2], [-tx, 0, -tz], up, wSign, hh, r, 1.15);
        }
      }
      if (count > 900) break;
    }
    if (count > 900) break;
  }

  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aGlow', new THREE.Float32BufferAttribute(ext, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, signMaterial(uniforms));
  m.userData.tris = idx.length / 3;
  m.userData.signs = count;
  return m;
}

let _sm = null;
export function signMaterial(uniforms) {
  if (_sm) return _sm;
  _sm = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uAtlas: { value: atlas().tex } },
    vertexShader: /* glsl */`
      attribute float aGlow;
      varying vec2 vUv; varying float vGlow;
      ${SCENE_PARS}
      void main(){
        vUv = uv; vGlow = aGlow;
        vec4 wp = modelMatrix*vec4(position,1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix*viewMatrix*wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D uAtlas;
      varying vec2 vUv; varying float vGlow;
      ${SCENE_PARS}
      ${COMMON}
      void main(){
        vec3 t = texture2D(uAtlas, vUv).rgb;
        // 형광등이 들어간 아크릴 간판처럼: 바탕은 은은하고 글자는 세게 빛난다
        float lum = dot(t, vec3(0.299,0.587,0.114));
        vec3 col = t * ((0.42 + 1.35*lum) * uArtificial + uDayLight * 1.15) * vGlow;
        ${FOG_APPLY}
        col = mix(col, uFogColor, fogF*0.55);
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.FrontSide,
  });
  return _sm;
}
export function resetSignMaterial(){ _sm = null; }
