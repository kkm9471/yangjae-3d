// 바닥. 아무것도 없는 곳은 검은 구멍이 되므로 큰 판 하나를 깔고,
// 그 위에 공원·물·주차장 같은 '면' 데이터를 얹는다.

import * as THREE from 'three';
import { COMMON, SCENE_PARS, SHADE, FOG_APPLY } from '../util/glsl.js';

const KIND_ID = { green: 0, water: 1, parking: 2, pitch: 3 };

export function createBaseGround(uniforms, size = 3000) {
  const g = new THREE.PlaneGeometry(size, size, 1, 1);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      ${SCENE_PARS}
      varying vec2 vP;
      void main(){
        vec4 wp = modelMatrix * vec4(position,1.0);
        vWorld = wp.xyz; vP = wp.xz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${SCENE_PARS}
      varying vec2 vP;
      ${COMMON}
      ${SHADE}
      void main(){
        vec3 base = vec3(0.040,0.040,0.044);
        base *= 0.75 + 0.5*fbm2(vP*0.03);
        vec3 col = shadeNight(vec3(0.0,1.0,0.0), base);
        ${FOG_APPLY}
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col,1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = -0.06;
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

function signedArea(r) {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) { const a = r[i], b = r[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
  return s * 0.5;
}

export function buildAreaMesh(chunk, uniforms) {
  const pos = [], uv = [], meta = [], idx = [];
  let vb = 0;
  for (const a of chunk.areas || []) {
    let ring = a.poly;
    if (!ring || ring.length < 3) continue;
    if (signedArea(ring) < 0) ring = ring.slice().reverse();
    const holes = (a.holes || []).map(h => (signedArea(h) > 0 ? h.slice().reverse() : h));
    const kid = KIND_ID[a.kind] ?? 0;
    const y = a.kind === 'water' ? 0.03 : 0.05;
    try {
      const contour = ring.map(p => new THREE.Vector2(p[0], p[1]));
      const holeV = holes.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
      const faces = THREE.ShapeUtils.triangulateShape(contour, holeV);
      const all = contour.concat(...holeV);
      const start = vb;
      for (const v of all) { pos.push(v.x, y, v.y); uv.push(v.x, v.y); meta.push(kid, 0, 0, 0); }
      vb += all.length;
      for (const f of faces) {
        const A = all[f[0]], B = all[f[1]], C = all[f[2]];
        const cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
        if (cr > 0) idx.push(start + f[0], start + f[2], start + f[1]);
        else idx.push(start + f[0], start + f[1], start + f[2]);
      }
    } catch (e) { /* skip */ }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aMeta', new THREE.Float32BufferAttribute(meta, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, areaMaterial(uniforms));
  m.userData.tris = idx.length / 3;
  return m;
}

let _mat = null;
export function areaMaterial(uniforms) {
  if (_mat) return _mat;
  _mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec4 aMeta;
      ${SCENE_PARS}
      varying vec2 vUv; varying vec4 vMeta;
      void main(){
        vUv = uv; vMeta = aMeta;
        vec4 wp = modelMatrix*vec4(position,1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix*viewMatrix*wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${SCENE_PARS}
      varying vec2 vUv; varying vec4 vMeta;
      ${COMMON}
      ${SHADE}
      void main(){
        float k = vMeta.x;
        vec3 base; vec3 emis = vec3(0.0);
        if(k < 0.5){                       // 잔디·수목
          base = vec3(0.030,0.055,0.032)*(0.7+0.7*fbm2(vUv*0.5));
        } else if(k < 1.5){                // 물
          base = vec3(0.018,0.028,0.048);
          float w = fbm2(vUv*0.35 + uTime*0.03);
          base += vec3(0.02,0.05,0.09)*pow(w,3.0);
          emis += vec3(0.35,0.45,0.8)*pow(w,7.0)*0.5*mix(0.35,1.0,uArtificial);
        } else if(k < 2.5){                // 주차장
          base = vec3(0.058,0.058,0.062)*(0.85+0.3*fbm2(vUv*0.8));
          float sx = smoothstep(0.05,0.0, abs(fract(vUv.x/2.6)-0.5)-0.47);
          base = mix(base, vec3(0.28,0.28,0.26), sx*0.5);
        } else {                           // 운동장
          base = vec3(0.055,0.048,0.038)*(0.85+0.3*fbm2(vUv*0.6));
        }
        vec3 col = shadeNight(vec3(0.0,1.0,0.0), base) + emis;
        ${FOG_APPLY}
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col,1.0);
      }`,
  });
  return _mat;
}
export function resetAreaMaterial(){ _mat = null; }
