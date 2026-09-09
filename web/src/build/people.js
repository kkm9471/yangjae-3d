// 보행자.
//
// 수천 명을 CPU로 매 프레임 움직이면 프레임이 떨어진다.
// 그래서 '어디서 어디까지 몇 m/s로 걷는가'만 정점에 실어 보내고,
// 실제 위치·걸음걸이는 GPU가 매 프레임 계산한다 (CPU 갱신 0회).

import * as THREE from 'three';
import { CFG } from '../config.js';
import { SCENE_PARS, COMMON, SHADE, FOG_APPLY } from '../util/glsl.js';
import { h32, rnd } from '../util/rand.js';
import { offsetPolyline } from './roads.js';

// 사람 하나의 저폴리 형태 (몸통·머리·다리 2개)
function personGeometry() {
  const pos = [], nrm = [], part = [];
  let idx = [], v = 0;
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
  // part: 0=몸통 1=머리 2=왼다리 3=오른다리
  box(0, 0.78, 0, 0.40, 0.62, 0.24, 0);      // 몸통
  box(0, 1.40, 0, 0.21, 0.23, 0.21, 1);      // 머리
  box(-0.10, 0.0, 0, 0.15, 0.80, 0.16, 2);   // 왼다리
  box(0.10, 0.0, 0, 0.15, 0.80, 0.16, 3);    // 오른다리

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

let _base = null;
function baseGeom() { if (!_base) _base = personGeometry(); return _base; }

export function buildPeopleMesh(chunk, uniforms) {
  // 보도(도로 양옆) + 보행로를 걷는 길로 삼는다
  const paths = [];
  for (const r of chunk.roads || []) {
    if (r.tunnel || r.sw < 1.0 || r.pts.length < 2) continue;
    const half = r.w / 2 + r.sw * 0.5;
    for (const s of [1, -1]) paths.push({ pts: offsetPolyline(r.pts, s * half), busy: r.z >= 5 ? 1.6 : r.z >= 3 ? 1.0 : 0.55 });
  }
  for (const f of chunk.footways || []) {
    if (f.tunnel || f.pts.length < 2 || f.cls === 'steps') continue;
    paths.push({ pts: f.pts, busy: 0.8 });
  }
  if (!paths.length) return null;

  const start = [], dir = [], len = [], spd = [], pha = [], tint = [];
  let n = 0;
  for (const p of paths) {
    // 폴리라인을 직선 구간으로 쪼개고, 긴 구간에만 사람을 둔다
    for (let i = 0; i < p.pts.length - 1; i++) {
      const a = p.pts[i], b = p.pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz);
      if (L < 6) continue;
      const cnt = Math.max(1, Math.round(L / 1000 * CFG.peoplePerKm * p.busy));
      const ux = dx / L, uz = dz / L;
      for (let k = 0; k < cnt; k++) {
        const sd = h32(Math.round(a[0] * 5), Math.round(a[1] * 5), k * 7 + i);
        const lateral = (rnd(sd, 1) - 0.5) * 2.0;     // 보도 폭 안에서 좌우로 흩어짐
        start.push(a[0] - uz * lateral, 0, a[1] + ux * lateral);
        dir.push(ux, uz);
        len.push(L);
        spd.push(0.85 + rnd(sd, 2) * 0.75);
        pha.push(rnd(sd, 3) * L * 2);
        // 밤 옷차림: 대부분 어둡고 가끔 밝은 색
        const bright = rnd(sd, 4);
        // 밤거리의 사람은 대부분 실루엣이다. 밝게 하면 마네킹처럼 보인다.
        const c = bright > 0.92 ? [0.20, 0.19, 0.185]
                : bright > 0.72 ? [0.14, 0.13, 0.17]
                : bright > 0.44 ? [0.075, 0.078, 0.098]
                                : [0.045, 0.045, 0.058];
        tint.push(c[0], c[1], c[2]);
        n++;
        if (n >= CFG.maxPeoplePerChunk) break;
      }
      if (n >= CFG.maxPeoplePerChunk) break;
    }
    if (n >= CFG.maxPeoplePerChunk) break;
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
  // 인스턴스가 움직이므로 넉넉한 경계구로 잘림을 막는다
  g.boundingSphere = new THREE.Sphere(
    new THREE.Vector3((chunk.cx + 0.5) * CFG.chunkSize, 1, (chunk.cz + 0.5) * CFG.chunkSize),
    CFG.chunkSize * 0.75 + 50);

  const m = new THREE.Mesh(g, peopleMaterial(uniforms));
  m.frustumCulled = true;
  m.userData.tris = (b.index.count / 3) * n;
  m.userData.people = n;
  m.userData.sharedBase = true;   // 원본 지오메트리를 모든 청크가 공유한다
  return m;
}

let _mat = null;
export function peopleMaterial(uniforms) {
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
        vPart = aPart;
        // 구간을 왕복하며 걷는다
        float cyc = aLen*2.0;
        float t = mod(uTime*aSpeed + aPhase, cyc);
        float s  = t < aLen ? t : cyc - t;
        float sgn = t < aLen ? 1.0 : -1.0;
        vec2 d = aDir*sgn;

        // 걸음: 다리를 앞뒤로 흔든다
        float gait = sin(uTime*aSpeed*3.4 + aPhase*3.1);
        vec3 lp = position;
        if(aPart > 1.5){
          float side = (aPart > 2.5) ? 1.0 : -1.0;
          float k = clamp((0.80 - position.y)/0.80, 0.0, 1.0);
          lp.z += gait*side*0.30*k;
          lp.y += max(0.0, gait*side)*0.06*k;
        } else {
          lp.y += abs(gait)*0.025;
          lp.z += gait*0.02;
        }

        // 진행 방향으로 회전 (로컬 +z 가 앞)
        float ca = d.y, sa = d.x;
        vec3 rp = vec3(lp.x*ca + lp.z*sa, lp.y, -lp.x*sa + lp.z*ca);
        vec3 rn = vec3(normal.x*ca + normal.z*sa, normal.y, -normal.x*sa + normal.z*ca);

        vec3 wp = aStart + vec3(d.x,0.0,d.y)*s + rp;
        vN = rn; vTint = aTint;
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
        // 머리만 피부색, 나머지는 옷 색
        vec3 base = (vPart > 0.5 && vPart < 1.5) ? vec3(0.085,0.065,0.052) : vTint;
        vec3 col = shadeNight(normalize(vN), base);
        // 가로등·간판 불빛이 몸에 반사되는 느낌(옷 색을 곱해야 사람이 마네킹이 안 된다)
        col += base * vec3(1.0,0.66,0.34) * 0.36 * uArtificial;
        // 뒤에서 오는 불빛에 실루엣 가장자리만 살짝 살아난다
        vec3 vd = normalize(vWorld - cameraPosition);
        float rim = pow(1.0 - abs(dot(normalize(vN), vd)), 4.0);
        col += vec3(1.0,0.72,0.40) * rim * 0.045 * uArtificial;
        ${FOG_APPLY}
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col,1.0);
      }`,
    side: THREE.DoubleSide,
  });
  return _mat;
}
export function resetPeopleMaterial(){ _mat = null; }
