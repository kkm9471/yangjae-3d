// 지형(산·언덕·해안).
//
// 지금까지 이 세계는 완전히 평평했다. 평지인 동네에서는 티가 안 나지만
// 제주도를 평평하게 만들면 한라산 1,947m 가 바닥이 되고, 그건 제주도가 아니다.
//
// 문제는 넓이다. 제주도는 90km x 60km 이고, 60m 간격으로 재면 150만 점이 된다.
// 그걸 다 그리면 화면이 죽는다. 그래서 **카메라 주변만 촘촘하고 멀수록 성기게** 그린다.
//
//   0단계  60m 간격, 반경 2km    ← 발밑. 걸어 다닐 때 보는 곳
//   1단계 240m 간격, 반경 8km    ← 건너편 마을
//   2단계 960m 간격, 반경 31km   ← 한라산 실루엣
//
// 1·2단계는 가운데가 뚫린 '액자' 모양이다(안쪽은 더 촘촘한 단계가 그린다).
// 액자끼리 만나는 자리에는 높이가 미세하게 어긋나 틈이 생기는데,
// 그 경계의 정점을 아래로 늘어뜨려(치마) 틈이 보이지 않게 막는다.
//
// 격자는 자기 간격의 배수 자리에만 놓는다. 안 그러면 카메라가 움직일 때마다
// 정점이 조금씩 미끄러져서 지형이 물결치는 것처럼 보인다.

import * as THREE from 'three';
import { SCENE_PARS, COMMON, SHADE, FOG_APPLY } from '../util/glsl.js';

const LEVELS = [
  { step: 1, half: 34 },      // step 은 아래에서 '높이판 간격의 배수'로 바뀐다
  { step: 4, half: 34 },
  { step: 16, half: 34 },
];
const SKIRT = 60;             // 액자 경계에서 아래로 늘어뜨리는 길이(m)
const MOVE_REBUILD = 0.34;    // 이 비율만큼 움직이면 그 단계를 다시 만든다

export class Terrain {
  constructor(scene, uniforms) {
    this.scene = scene;
    this.uniforms = uniforms;
    this.meta = null;
    this.h = null;              // Int16Array
    this.ready = false;
    this.meshes = [];
    this.lastAt = [];
    this.sea = null;
    this._group = new THREE.Group();
    scene.add(this._group);
  }

  /**
   * 높이판을 읽어 온다. 없으면 조용히 꺼진 채로 둔다(지형 없는 동네도 있다).
   * @param {string} base  예: './data'
   * @param {string} slug
   */
  async load(base, slug) {
    let meta;
    try {
      const r = await fetch(`${base}/dem/${slug}.json`, { cache: 'no-store' });
      if (!r.ok) return false;
      meta = await r.json();
      const b = await fetch(`${base}/dem/${slug}.bin`);
      if (!b.ok) return false;
      this.h = new Int16Array(await b.arrayBuffer());
    } catch {
      return false;
    }
    if (!meta || !this.h || this.h.length !== meta.nx * meta.nz) {
      // 크기가 안 맞으면 절반만 그려진 지형이 나온다. 그건 없느니만 못하다.
      console.warn('[지형] 크기가 맞지 않아 쓰지 않습니다',
        this.h && this.h.length, meta && meta.nx * meta.nz);
      return false;
    }
    this.meta = meta;
    this.unit = meta.unit || 0.1;
    // 원점(화면 좌표 0,0)의 높이를 빼서 기준을 맞춘다.
    // 이걸 안 하면 양재(해발 34m)에서 이미 지어 둔 건물들이 땅에 파묻힌다.
    this.base = this._raw(0, 0);
    this.levels = LEVELS.map(l => ({ step: l.step * meta.step, half: l.half }));
    this._build();
    this.ready = true;
    return true;
  }

  /** 높이판을 그대로 읽는다(해발 m) */
  _raw(x, z) {
    const m = this.meta;
    if (!m) return 0;
    const fx = (x + m.halfX) / m.step;
    const fz = (z + m.halfZ) / m.step;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= m.nx - 1 || j >= m.nz - 1) {
      // ★ 데이터 밖은 '가장자리 높이를 그대로 이어간다'.
      //   여기서 바다(0m)를 돌려주면, 데이터가 좁은 동네는 사방이 바다가 되어
      //   양재가 바다 한가운데 뜬 섬처럼 보인다(실제로 그렇게 나왔다).
      //   제주처럼 가장자리가 진짜 바다인 데이터는 이어가기만 해도 바다가 된다.
      const ci = Math.max(0, Math.min(m.nx - 1, i));
      const cj = Math.max(0, Math.min(m.nz - 1, j));
      return this.h[cj * m.nx + ci] * this.unit;
    }
    const tx = fx - i, tz = fz - j;
    const n = m.nx;
    const a = this.h[j * n + i], b = this.h[j * n + i + 1];
    const c = this.h[(j + 1) * n + i], d = this.h[(j + 1) * n + i + 1];
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return (top + (bot - top) * tz) * this.unit;
  }

  /** 화면 좌표계에서의 땅 높이(원점 기준) */
  heightAt(x, z) {
    if (!this.ready) return 0;
    return this._raw(x, z) - this.base;
  }

  /** 그 자리가 바다인가 */
  isSea(x, z) {
    if (!this.ready) return false;
    return this._raw(x, z) <= (this.meta.seaLevel || 0) + 0.5;
  }

  /** 바다 높이(화면 좌표계) */
  get seaY() {
    return this.ready ? (this.meta.seaLevel || 0) - this.base : -1e9;
  }

  _build() {
    const mat = terrainMaterial(this.uniforms);
    for (let li = 0; li < this.levels.length; li++) {
      const lv = this.levels[li];
      const n = lv.half * 2;                       // 칸 수
      const vn = n + 1;
      const pos = new Float32Array(vn * vn * 3);
      const idx = [];
      // 1단계부터는 가운데를 비운다(더 촘촘한 단계가 거기를 그린다)
      const hole = li === 0 ? -1 : lv.half / 2;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const ci = i - lv.half + 0.5, cj = j - lv.half + 0.5;
          if (hole > 0 && Math.abs(ci) < hole && Math.abs(cj) < hole) continue;
          const a = j * vn + i, b = a + 1, c = a + vn, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vn * vn * 3), 3));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;      // 정점을 CPU가 계속 바꾸므로 경계상자를 못 믿는다
      mesh.renderOrder = -10 + li;     // 지형은 제일 먼저 (건물·도로가 그 위에 얹힌다)
      this._group.add(mesh);
      this.meshes.push({ mesh, lv, vn, pos, hole });
      this.lastAt.push(null);
    }

    // 바다. 단, 그 지역에 실제로 바다가 있을 때만 깐다.
    // 내륙 동네(양재·진주 시내)에 바다를 깔면 낮은 땅이 물에 잠긴 것처럼 보인다.
    this.hasSea = (this.meta.min ?? 0) <= (this.meta.seaLevel || 0) + 1.0;
    if (this.hasSea) {
      const sg = new THREE.PlaneGeometry(400000, 400000, 1, 1);
      sg.rotateX(-Math.PI / 2);
      this.sea = new THREE.Mesh(sg, seaMaterial(this.uniforms));
      this.sea.position.y = this.seaY;
      this.sea.renderOrder = -20;
      this.sea.frustumCulled = false;
      this._group.add(this.sea);
    }
  }

  /** 매 프레임. 카메라가 충분히 움직였을 때만 그 단계를 다시 만든다. */
  update(camera) {
    if (!this.ready) return;
    const cx = camera.position.x, cz = camera.position.z;
    for (let li = 0; li < this.meshes.length; li++) {
      const M = this.meshes[li];
      const st = M.lv.step;
      // 자기 간격의 배수 자리에만 놓는다 → 카메라가 움직여도 정점이 미끄러지지 않는다
      const ox = Math.round(cx / st) * st;
      const oz = Math.round(cz / st) * st;
      const at = this.lastAt[li];
      if (at && Math.abs(at[0] - ox) < st * MOVE_REBUILD
             && Math.abs(at[1] - oz) < st * MOVE_REBUILD) continue;
      this.lastAt[li] = [ox, oz];
      this._fill(M, ox, oz);
    }
    if (this.sea) this.sea.position.set(cx, this.seaY, cz);
  }

  _fill(M, ox, oz) {
    const { lv, vn, pos, hole } = M;
    const st = lv.step, half = lv.half;
    const g = M.mesh.geometry;
    const nrm = g.attributes.normal.array;
    for (let j = 0; j < vn; j++) {
      for (let i = 0; i < vn; i++) {
        const k = (j * vn + i) * 3;
        const x = ox + (i - half) * st;
        const z = oz + (j - half) * st;
        let y = this.heightAt(x, z);
        // 액자의 안쪽·바깥쪽 가장자리는 아래로 늘어뜨려 틈을 가린다
        const ci = i - half, cj = j - half;
        const outer = (i === 0 || j === 0 || i === vn - 1 || j === vn - 1);
        const inner = hole > 0
          && Math.max(Math.abs(ci), Math.abs(cj)) <= hole + 0.5
          && Math.max(Math.abs(ci), Math.abs(cj)) >= hole - 0.5;
        if (outer || inner) y -= SKIRT;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      }
    }
    // 법선 — 이웃 높이차로 바로 계산한다(geometry.computeVertexNormals 보다 훨씬 싸다)
    for (let j = 0; j < vn; j++) {
      for (let i = 0; i < vn; i++) {
        const k = (j * vn + i) * 3;
        const x = pos[k], z = pos[k + 2];
        const hl = this.heightAt(x - st, z), hr = this.heightAt(x + st, z);
        const hd = this.heightAt(x, z - st), hu = this.heightAt(x, z + st);
        let nx = hl - hr, ny = 2 * st, nz = hd - hu;
        const len = Math.hypot(nx, ny, nz) || 1;
        nrm[k] = nx / len; nrm[k + 1] = ny / len; nrm[k + 2] = nz / len;
      }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
  }

  dispose() {
    for (const M of this.meshes) M.mesh.geometry.dispose();
    this.scene.remove(this._group);
  }
}

let _mat = null;
function terrainMaterial(uniforms) {
  if (_mat) return _mat;
  _mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vN; varying float vH;
      ${SCENE_PARS}
      void main(){
        vN = normal; vH = position.y;
        vWorld = position;
        gl_Position = projectionMatrix * viewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vN; varying float vH;
      ${SCENE_PARS}
      ${COMMON}
      ${SHADE}
      void main(){
        vec3 n = normalize(vN);
        float slope = 1.0 - clamp(n.y, 0.0, 1.0);      // 0=평지 1=절벽
        float h = vH + uSeaOffset;                     // 해발(m)

        // 해발과 경사로 땅 색을 정한다. 바닷가 모래 → 들 → 숲 → 바위 → 눈
        vec3 sand  = vec3(0.52, 0.47, 0.38);
        vec3 field = vec3(0.22, 0.28, 0.16);
        vec3 wood  = vec3(0.13, 0.20, 0.12);
        vec3 rock  = vec3(0.28, 0.26, 0.24);
        vec3 snow  = vec3(0.72, 0.74, 0.78);
        vec3 col = mix(sand, field, smoothstep(2.0, 25.0, h));
        col = mix(col, wood, smoothstep(60.0, 340.0, h));
        col = mix(col, rock, smoothstep(900.0, 1500.0, h));
        col = mix(col, snow, smoothstep(1650.0, 1900.0, h));
        col = mix(col, rock, smoothstep(0.34, 0.62, slope));   // 가파르면 바위가 드러난다

        col = shadeNight(n, col);
        // 도시 불빛이 산자락에 옅게 번진다
        col += col * vec3(1.0,0.72,0.42) * 0.10 * uArtificial;
        ${FOG_APPLY}
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col,1.0);
      }`,
  });
  return _mat;
}

let _sea = null;
function seaMaterial(uniforms) {
  if (_sea) return _sea;
  _sea = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      ${SCENE_PARS}
      void main(){
        vec4 wp = modelMatrix * vec4(position,1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${SCENE_PARS}
      ${COMMON}
      ${SHADE}
      void main(){
        // 잔물결 — 그림 파일 없이 수식으로만
        vec2 p = vWorld.xz * 0.035;
        float w = sin(p.x*1.7 + uTime*0.35) * sin(p.y*1.3 - uTime*0.27)
                + 0.5*sin(p.x*3.1 - uTime*0.5) * sin(p.y*2.7 + uTime*0.41);
        vec3 n = normalize(vec3(w*0.045, 1.0, w*0.038));
        vec3 deep = vec3(0.012, 0.030, 0.052);
        vec3 shal = vec3(0.030, 0.072, 0.098);
        vec3 col = mix(deep, shal, clamp(w*0.5+0.5, 0.0, 1.0));
        col = shadeNight(n, col);
        // 하늘이 수면에 비친다 — 이게 없으면 바다가 검은 판때기가 된다
        vec3 vd = normalize(vWorld - cameraPosition);
        float fres = pow(1.0 - abs(dot(n, vd)), 4.0);
        col = mix(col, mix(uSkyHorizon, uSkyTop, 0.35), fres * 0.72);
        col += vec3(1.0,0.85,0.55) * pow(max(0.0, w), 6.0) * 0.05 * uArtificial;
        ${FOG_APPLY}
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col,1.0);
      }`,
  });
  return _sea;
}

export function resetTerrainMaterials() { _mat = null; _sea = null; }
