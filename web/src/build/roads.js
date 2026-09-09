// 도로·보도·횡단보도.
//
// OSM은 도로를 '선'으로만 준다. 폭·차선·중앙선은 여기서 만든다.
// 차선 도색은 텍스처가 아니라, 도로 중심에서 몇 m 떨어졌는지(v)를 정점에 실어
// 조각셰이더가 계산해서 그린다.

import * as THREE from 'three';
import { ROAD_STYLE } from '../config.js';
import { COMMON, SCENE_PARS, SHADE, FOG_APPLY, FOOTPRINT } from '../util/glsl.js';
import { h32 } from '../util/rand.js';

const K_ASPHALT = 0, K_WALK = 1, K_CURB = 2, K_CROSS = 3;

/** 폴리라인을 폭 w의 리본으로 만든다(마이터 조인) */
export function ribbon(pts, halfW) {
  const n = pts.length;
  const L = [], R = [], S = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    let dx, dz;
    if (i === 0) { dx = pts[1][0] - pts[0][0]; dz = pts[1][1] - pts[0][1]; }
    else if (i === n - 1) { dx = pts[n - 1][0] - pts[n - 2][0]; dz = pts[n - 1][1] - pts[n - 2][1]; }
    else { dx = pts[i + 1][0] - pts[i - 1][0]; dz = pts[i + 1][1] - pts[i - 1][1]; }
    const l = Math.hypot(dx, dz) || 1;
    let nx = -dz / l, nz = dx / l;
    // 꺾이는 각도만큼 폭을 늘려 안쪽이 벌어지지 않게 한다
    let mit = 1;
    if (i > 0 && i < n - 1) {
      const ax = pts[i][0] - pts[i - 1][0], az = pts[i][1] - pts[i - 1][1];
      const bx = pts[i + 1][0] - pts[i][0], bz = pts[i + 1][1] - pts[i][1];
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      const cosT = (ax * bx + az * bz) / (la * lb);
      mit = Math.min(2.6, 1 / Math.max(0.4, Math.sqrt((1 + cosT) / 2)));
    }
    if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    L.push([pts[i][0] + nx * halfW * mit, pts[i][1] + nz * halfW * mit]);
    R.push([pts[i][0] - nx * halfW * mit, pts[i][1] - nz * halfW * mit]);
    S.push(acc);
  }
  return { L, R, S };
}

/** 폴리라인을 옆으로 d만큼 평행이동 */
export function offsetPolyline(pts, d) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    let dx, dz;
    if (i === 0) { dx = pts[1][0] - pts[0][0]; dz = pts[1][1] - pts[0][1]; }
    else if (i === n - 1) { dx = pts[n - 1][0] - pts[n - 2][0]; dz = pts[n - 1][1] - pts[n - 2][1]; }
    else { dx = pts[i + 1][0] - pts[i - 1][0]; dz = pts[i + 1][1] - pts[i - 1][1]; }
    const l = Math.hypot(dx, dz) || 1;
    out.push([pts[i][0] + (-dz / l) * d, pts[i][1] + (dx / l) * d]);
  }
  return out;
}

/** 리본을 정점 배열에 밀어 넣는다 */
function pushRibbon(buf, pts, halfW, y, kind, road) {
  const { L, R, S } = ribbon(pts, halfW);
  const n = pts.length;
  const base = buf.vcount;
  for (let i = 0; i < n; i++) {
    const lx = L[i][0], lz = L[i][1], rx = R[i][0], rz = R[i][1];
    buf.pos.push(lx, y, lz, rx, y, rz);
    buf.nrm.push(0, 1, 0, 0, 1, 0);
    buf.uv.push(S[i], halfW, S[i], -halfW);
    buf.meta.push(kind, road[0], road[1], road[2]);
    buf.meta.push(kind, road[0], road[1], road[2]);
  }
  buf.vcount += n * 2;
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
    buf.idx.push(a, b, c, b, d, c);
  }
}

/** 수직 연석면 */
function pushCurb(buf, pts, offsetDist, y0, y1, road) {
  const { L, R, S } = ribbon(pts, Math.abs(offsetDist));
  const line = offsetDist > 0 ? L : R;
  const n = pts.length;
  const base = buf.vcount;
  for (let i = 0; i < n; i++) {
    let dx, dz;
    if (i === 0) { dx = pts[1][0] - pts[0][0]; dz = pts[1][1] - pts[0][1]; }
    else if (i === n - 1) { dx = pts[n - 1][0] - pts[n - 2][0]; dz = pts[n - 1][1] - pts[n - 2][1]; }
    else { dx = pts[i + 1][0] - pts[i - 1][0]; dz = pts[i + 1][1] - pts[i - 1][1]; }
    const l = Math.hypot(dx, dz) || 1;
    const sgn = offsetDist > 0 ? 1 : -1;
    const nx = (-dz / l) * sgn, nz = (dx / l) * sgn;
    buf.pos.push(line[i][0], y0, line[i][1], line[i][0], y1, line[i][1]);
    buf.nrm.push(-nx, 0, -nz, -nx, 0, -nz);
    buf.uv.push(S[i], 0, S[i], 1);
    buf.meta.push(K_CURB, road[0], road[1], road[2]);
    buf.meta.push(K_CURB, road[0], road[1], road[2]);
  }
  buf.vcount += n * 2;
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    buf.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

export function buildRoadMesh(chunk, uniforms) {
  const buf = { pos: [], nrm: [], uv: [], meta: [], idx: [], vcount: 0 };

  for (const r of chunk.roads || []) {
    if (r.tunnel) continue;
    if (r.pts.length < 2) continue;
    const sty = ROAD_STYLE[r.cls] || ROAD_STYLE.residential;
    const y = 0.02 + (r.z || 1) * 0.007 + (r.layer || 0) * 5.5;
    const half = r.w / 2;
    const seed = h32(r.id.length, r.pts[0][0] | 0, r.pts[0][1] | 0) % 4096;
    pushRibbon(buf, r.pts, half, y, K_ASPHALT, [r.lanes, r.oneway, r.w]);

    if (r.sw > 0.5) {
      const sy = y + 0.145;
      for (const s of [1, -1]) {
        const line = offsetPolyline(r.pts, s * (half + r.sw / 2));
        pushRibbon(buf, line, r.sw / 2, sy, K_WALK, [r.lanes, r.oneway, r.w]);
        pushCurb(buf, r.pts, s * half, y, sy, [r.lanes, r.oneway, r.w]);
      }
    }
  }

  for (const f of chunk.footways || []) {
    if (f.tunnel) continue;
    if (f.pts.length < 2) continue;
    const w = f.cls === 'steps' ? 2.0 : f.cls === 'cycleway' ? 2.4 : 2.6;
    pushRibbon(buf, f.pts, w / 2, 0.165 + (f.layer || 0) * 5.5, K_WALK, [1, 0, w]);
  }

  for (const x of chunk.crossings || []) {
    if (x.pts.length < 2) continue;
    pushRibbon(buf, x.pts, 2.1, 0.075, K_CROSS, [1, 0, 4.2]);
  }

  if (buf.idx.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setAttribute('aMeta', new THREE.Float32BufferAttribute(buf.meta, 4));
  g.setIndex(buf.idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, roadMaterial(uniforms));
  m.userData.tris = buf.idx.length / 3;
  return m;
}

let _mat = null;
export function roadMaterial(uniforms) {
  if (_mat) return _mat;
  _mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec4 aMeta;
      varying vec2 vUv; varying vec3 vN; varying vec4 vMeta;
      ${SCENE_PARS}
      void main(){
        vUv = uv; vMeta = aMeta;
        vN = normalize(mat3(modelMatrix)*normal);
        vec4 wp = modelMatrix * vec4(position,1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv; varying vec3 vN; varying vec4 vMeta;
      ${SCENE_PARS}
      ${COMMON}
      ${SHADE}
      ${FOOTPRINT}
      void main(){
        float kind   = vMeta.x;
        float lanes  = max(1.0, vMeta.y);
        float oneway = vMeta.z;
        float width  = max(1.0, vMeta.w);
        float u = vUv.x, v = vUv.y;
        // 화소가 노면에서 덮는 거리(m). 멀수록 커진다 → 도색·무늬를 흐려서 지글거림 제거
        float px = pixelFootprint(vWorld, vN);
        vec3 base; vec3 emis = vec3(0.0);

        if(kind < 0.5){
          // ── 아스팔트 ──
          base = vec3(0.052,0.053,0.058);
          base *= 0.80 + 0.40*fbm2(vec2(u*0.9, v*0.9));
          base += 0.012*noise2(vec2(u*7.0, v*7.0));

          float hw = width*0.5;
          float laneW = width/lanes;
          float k = (v + hw)/laneW;
          float dLine = abs(fract(k) - 0.5);        // 0=차선경계
          float distM = (0.5 - dLine)*laneW;        // 경계까지 m

          // 가장자리 실선
          float edge = smoothstep(0.10,0.045, abs(abs(v) - (hw-0.35)));
          // 차선 점선
          float dash = step(fract(u/7.0), 0.45);
          float lane = smoothstep(0.085,0.035, distM) * dash;
          // 양방향이면 중앙 황색 2줄
          float cy = 0.0;
          if(oneway < 0.5){
            cy = smoothstep(0.07,0.03, abs(abs(v)-0.16));
            lane *= 1.0 - smoothstep(0.9,0.2, abs(v));
          }
          vec3 paint = mix(vec3(0.62,0.63,0.64), vec3(0.60,0.48,0.10), step(0.5, cy));
          float pm = clamp(max(max(edge, lane), cy), 0.0, 1.0);
          // 도색은 낡아서 군데군데 벗겨진다
          pm *= 0.55 + 0.45*noise2(vec2(u*0.7, v*3.0));
          // 멀어지면 선이 1픽셀 이하가 되어 반짝인다 → 부드럽게 지운다
          pm *= clamp(1.0 - px/0.55, 0.0, 1.0);
          base = mix(base, paint, pm);
          emis += paint * pm * 0.12 * uArtificial;

          // 젖은 노면에 번지는 불빛(도시 야경의 핵심)
          float streak = pow(fbm2(vec2(u*0.035, v*0.55)), 3.0);
          float nearEdge = smoothstep(hw, hw*0.35, abs(v));
          emis += vec3(1.00,0.66,0.34) * streak * (0.06 + 0.15*nearEdge) * uArtificial;
          emis += vec3(0.45,0.62,1.00) * pow(noise2(vec2(u*0.02+11.0, v*0.4)),4.0) * 0.10 * uArtificial;
        }
        else if(kind < 1.5){
          // ── 보도(보도블록) ──
          base = vec3(0.108,0.106,0.100);
          vec2 bl = vec2(u/0.62, v/0.31);
          float gx = abs(fract(bl.x)-0.5), gy = abs(fract(bl.y)-0.5);
          float grout = smoothstep(0.47,0.50,max(gx,gy)) * clamp(1.0 - px/0.22, 0.0, 1.0);
          base *= 0.86 + 0.28*hash12(floor(bl));
          base = mix(base, base*0.62, grout);
          base *= 0.88 + 0.24*fbm2(vec2(u*0.4, v*0.4));
          emis += vec3(1.0,0.75,0.45)*pow(fbm2(vec2(u*0.06,v*0.5)),4.0)*0.07*uArtificial;
        }
        else if(kind < 2.5){
          // ── 연석 ──
          base = vec3(0.155,0.152,0.146) * (0.85+0.3*hash11(floor(u*1.2)));
        }
        else {
          // ── 횡단보도 ──
          float st = mix(0.58, step(fract(u/1.15), 0.58), clamp(1.0 - px/0.5, 0.0, 1.0));
          base = mix(vec3(0.055,0.056,0.060), vec3(0.68,0.69,0.70), st);
          base *= 0.7 + 0.5*noise2(vec2(u*3.0, v*3.0));
          emis += vec3(0.55,0.58,0.62)*st*0.16*uArtificial;
        }

        vec3 col = shadeNight(normalize(vN), base) + emis;
        ${FOG_APPLY}
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col,1.0);
      }`,
    side: THREE.DoubleSide,
  });
  return _mat;
}
export function resetRoadMaterial(){ _mat = null; }
