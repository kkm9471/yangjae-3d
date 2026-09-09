// 차량.
//
// 사람과 같은 방식: 직선 구간 하나를 배정받아 GPU가 스스로 달린다.
// 밤에는 차체보다 전조등·후미등이 먼저 보이므로 그쪽에 공을 들인다.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { SCENE_PARS, COMMON, SHADE, FOG_APPLY } from '../util/glsl.js';
import { h32, rnd } from '../util/rand.js';
import { offsetPolyline } from './roads.js';

// part: 0=차체 1=유리 2=전조등 3=후미등
function carGeometry() {
  const pos = [], nrm = [], part = [];
  const idx = []; let v = 0;
  const box = (x, y, z, w, h, d, p) => {
    const hx = w / 2, hz = d / 2;
    const c = [[x - hx, z - hz], [x + hx, z - hz], [x + hx, z + hz], [x - hx, z + hz]];
    const q = (a, b, n) => {
      pos.push(a[0], y, a[1], b[0], y, b[1], b[0], y + h, b[1], a[0], y + h, a[1]);
      for (let i = 0; i < 4; i++) { nrm.push(n[0], n[1], n[2]); part.push(p); }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
    };
    q(c[0], c[1], [0, 0, -1]); q(c[1], c[2], [1, 0, 0]);
    q(c[2], c[3], [0, 0, 1]); q(c[3], c[0], [-1, 0, 0]);
    pos.push(c[0][0], y + h, c[0][1], c[1][0], y + h, c[1][1], c[2][0], y + h, c[2][1], c[3][0], y + h, c[3][1]);
    for (let i = 0; i < 4; i++) { nrm.push(0, 1, 0); part.push(p); }
    idx.push(v, v + 2, v + 1, v, v + 3, v + 2); v += 4;
  };
  box(0, 0.16, 0, 1.78, 0.72, 4.40, 0);      // 차체 아래
  box(0, 0.86, -0.15, 1.62, 0.62, 2.35, 1);  // 유리·지붕
  box(-0.60, 0.40, 2.18, 0.42, 0.22, 0.10, 2);  // 전조등 좌
  box(0.60, 0.40, 2.18, 0.42, 0.22, 0.10, 2);   // 전조등 우
  box(-0.62, 0.55, -2.22, 0.44, 0.18, 0.10, 3); // 후미등 좌
  box(0.62, 0.55, -2.22, 0.44, 0.18, 0.10, 3);  // 후미등 우

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

let _base = null;
function baseGeom() { if (!_base) _base = carGeometry(); return _base; }

export function buildCarsMesh(chunk, uniforms) {
  const start = [], dir = [], len = [], spd = [], pha = [], tint = [];
  let n = 0;

  for (const r of chunk.roads || []) {
    if (r.tunnel || r.pts.length < 2) continue;
    if (r.z < 3) continue;                       // 골목·서비스도로는 생략
    const lanes = Math.max(1, r.lanes);
    const laneW = r.w / lanes;
    const half = r.w / 2;

    for (let li = 0; li < lanes; li++) {
      // 중앙버스전용차로(맨 안쪽)는 비워 둔다
      const offCenter = -half + laneW * (li + 0.5);
      const line = offsetPolyline(r.pts, offCenter);
      // 우측통행. offsetPolyline 의 법선 (-dz,dx) 는 '진행방향 오른쪽'이므로
      // offCenter>0 인 차선이 폴리라인과 같은 방향(정방향)이다.
      // 부호를 반대로 두면 서울인데 영국식 좌측통행이 된다(실제로 그랬다).
      const forward = r.oneway ? 1 : (offCenter > 0 ? 1 : -1);
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const L = Math.hypot(dx, dz);
        if (L < 25) continue;
        const cnt = Math.max(1, Math.round(L / 1000 * CFG.carsPerKm));
        const ux = (dx / L) * forward, uz = (dz / L) * forward;
        const ox = forward > 0 ? a[0] : b[0], oz = forward > 0 ? a[1] : b[1];
        for (let k = 0; k < cnt; k++) {
          const sd = h32(Math.round(a[0] * 5), Math.round(a[1] * 5), li * 31 + k * 7 + i);
          if (rnd(sd, 9) < 0.35) continue;      // 차간 간격이 들쭉날쭉하게
          start.push(ox, 0, oz);
          dir.push(ux, uz);
          len.push(L);
          spd.push(7.5 + rnd(sd, 2) * 7.0);     // 25~52 km/h
          pha.push(rnd(sd, 3) * L);
          const c = rnd(sd, 4);
          const col = c > 0.80 ? [0.55, 0.56, 0.58]   // 은색
                    : c > 0.62 ? [0.72, 0.72, 0.74]   // 흰색
                    : c > 0.45 ? [0.06, 0.06, 0.07]   // 검정
                    : c > 0.34 ? [0.10, 0.12, 0.20]
                    : c > 0.28 ? [0.22, 0.06, 0.06]
                               : [0.14, 0.15, 0.16];
          tint.push(col[0], col[1], col[2]);
          n++;
          if (n >= CFG.maxCars) break;
        }
        if (n >= CFG.maxCars) break;
      }
      if (n >= CFG.maxCars) break;
    }
    if (n >= CFG.maxCars) break;
  }
  if (!n) return null;

  const g = new THREE.InstancedBufferGeometry();
  const b = baseGeom();
  g.index = b.index;
  g.setAttribute('position', b.getAttribute('position'));
  g.setAttribute('normal', b.getAttribute('normal'));
  g.setAttribute('aPart', b.getAttribute('aPart'));
  g.setAttribute('aStart', new THREE.InstancedBufferAttribute(new Float32Array(start), 3));
  g.setAttribute('aDir', new THREE.InstancedBufferAttribute(new Float32Array(dir), 2));
  g.setAttribute('aLen', new THREE.InstancedBufferAttribute(new Float32Array(len), 1));
  g.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(new Float32Array(spd), 1));
  g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(pha), 1));
  g.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(tint), 3));
  g.instanceCount = n;
  g.boundingSphere = new THREE.Sphere(
    new THREE.Vector3((chunk.cx + 0.5) * CFG.chunkSize, 1, (chunk.cz + 0.5) * CFG.chunkSize),
    CFG.chunkSize * 0.75 + 60);

  const m = new THREE.Mesh(g, carMaterial(uniforms));
  m.userData.tris = (b.index.count / 3) * n;
  m.userData.cars = n;
  m.userData.sharedBase = true;   // 원본 지오메트리를 모든 청크가 공유한다
  return m;
}

let _mat = null;
export function carMaterial(uniforms) {
  if (_mat) return _mat;
  _mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute float aPart;
      attribute vec3 aStart, aTint;
      attribute vec2 aDir;
      attribute float aLen, aSpeed, aPhase;
      varying vec3 vN, vTint; varying float vPart;
      ${SCENE_PARS}
      void main(){
        float s = mod(uTime*aSpeed + aPhase, aLen);
        vec2 d = aDir;
        float ca = d.y, sa = d.x;
        vec3 lp = position;
        vec3 rp = vec3(lp.x*ca + lp.z*sa, lp.y, -lp.x*sa + lp.z*ca);
        vec3 rn = vec3(normal.x*ca + normal.z*sa, normal.y, -normal.x*sa + normal.z*ca);
        vec3 wp = aStart + vec3(d.x,0.0,d.y)*s + rp;
        vN = rn; vTint = aTint; vPart = aPart;
        vWorld = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vN, vTint; varying float vPart;
      ${SCENE_PARS}
      ${COMMON}
      ${SHADE}
      void main(){
        vec3 col;
        if(vPart > 2.5){          // 후미등
          col = vec3(1.0,0.10,0.06) * 2.4 * mix(0.10, 1.0, uArtificial);
        } else if(vPart > 1.5){   // 전조등
          col = vec3(1.0,0.95,0.82) * 3.2 * mix(0.14, 1.0, uArtificial);
        } else if(vPart > 0.5){   // 유리
          col = shadeNight(normalize(vN), vec3(0.030,0.036,0.050)) + vec3(0.05,0.05,0.06);
        } else {                  // 차체
          vec3 c = shadeNight(normalize(vN), vTint);
          c += vTint * vec3(1.0,0.66,0.34) * 0.35 * uArtificial;   // 거리 불빛 반사
          col = c;
        }
        ${FOG_APPLY}
        float e = step(1.5, vPart);
        col = mix(col, uFogColor, fogF*(1.0-0.6*e));
        gl_FragColor = vec4(col,1.0);
      }`,
    side: THREE.DoubleSide,
  });
  return _mat;
}
export function resetCarMaterial(){ _mat = null; }
