// 같이 접속한 사람들의 아바타.
//
// 길에 깔린 군중(build/people.js)은 '어디서 어디까지 걷는가'를 미리 정해 두고
// GPU가 알아서 움직인다. 하지만 진짜 사람은 어디로 갈지 모른다.
// 그래서 위치는 CPU가 써 넣고(서버에서 받은 값), 걸음걸이만 GPU가 그린다.
//
// 몸은 군중과 같은 모양을 쓴다. 혼자만 다른 모양이면 그 사람만 붕 뜬다.
// 이름표는 3D 글자가 아니라 화면 위에 얹은 HTML 이다. 몇 명 안 되니 그게 훨씬 또렷하고 싸다.

import * as THREE from 'three';
import { SCENE_PARS, COMMON, SHADE, FOG_APPLY } from '../util/glsl.js';
import { personGeometry } from './people.js';

const MAX = 24;                 // 동시에 그릴 수 있는 사람 수
const EYE = 1.68;               // 상대의 눈높이 — 발밑을 맞추려면 이만큼 내려야 한다

// 사람마다 다른 옷 색. 서로 구별돼야 하므로 군중보다 훨씬 밝고 선명하게.
const TINTS = [
  [0.85, 0.30, 0.34], [0.28, 0.55, 0.88], [0.95, 0.72, 0.24], [0.35, 0.78, 0.52],
  [0.80, 0.42, 0.82], [0.30, 0.80, 0.80], [0.95, 0.52, 0.26], [0.62, 0.62, 0.92],
];

export class Avatars {
  constructor(scene, camera, uniforms) {
    this.camera = camera;
    this.slots = new Map();       // id → 슬롯 번호
    this.free = [];
    for (let i = MAX - 1; i >= 0; i--) this.free.push(i);

    const g = new THREE.InstancedBufferGeometry();
    const base = personGeometry();
    g.index = base.index;
    g.attributes.position = base.attributes.position;
    g.attributes.normal = base.attributes.normal;
    g.setAttribute('aPart', base.attributes.aPart);

    this.tint = new Float32Array(MAX * 3);
    this.walk = new Float32Array(MAX);      // 걸은 거리(m) — 걸음걸이의 위상이 된다
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.tint, 3));
    g.setAttribute('aWalk', new THREE.InstancedBufferAttribute(this.walk, 1));

    this.mesh = new THREE.InstancedMesh(g, avatarMaterial(uniforms), MAX);
    this.mesh.frustumCulled = false;        // 위치를 CPU가 바꾸므로 경계상자를 못 믿는다
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    // 이름표를 담을 곳
    this.layer = document.createElement('div');
    this.layer.id = 'tags';
    this.layer.style.cssText = 'position:fixed;inset:0;z-index:7;pointer-events:none;overflow:hidden';
    document.body.appendChild(this.layer);
    this.tags = new Map();        // id → div

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  _slot(id) {
    let s = this.slots.get(id);
    if (s === undefined) {
      if (!this.free.length) return -1;      // 자리가 없으면 그냥 안 그린다
      s = this.free.pop();
      this.slots.set(id, s);
      const c = TINTS[s % TINTS.length];
      this.tint[s * 3] = c[0]; this.tint[s * 3 + 1] = c[1]; this.tint[s * 3 + 2] = c[2];
      this.mesh.geometry.attributes.aTint.needsUpdate = true;
    }
    return s;
  }

  remove(id) {
    const s = this.slots.get(id);
    if (s !== undefined) { this.slots.delete(id); this.free.push(s); }
    const el = this.tags.get(id);
    if (el) { el.remove(); this.tags.delete(id); }
  }

  clear() {
    for (const id of [...this.slots.keys()]) this.remove(id);
  }

  /**
   * 매 프레임 부른다.
   * @param {Map} peers  id → {name, cx, cy, cz, cyaw, walked}
   */
  update(peers) {
    // 사라진 사람 치우기
    for (const id of [...this.slots.keys()]) if (!peers.has(id)) this.remove(id);

    let n = 0;
    for (const [id, p] of peers) {
      const s = this._slot(id);
      if (s < 0) continue;
      this.walk[s] = p.walked || 0;
      // 서버가 주는 y 는 '눈높이'다. 발을 땅에 대려면 그만큼 내린다.
      this._e.set(0, p.cyaw, 0, 'YXZ');
      this._q.setFromEuler(this._e);
      this._v.set(p.cx, p.cy - EYE, p.cz);
      this._m.compose(this._v, this._q, this._s);
      this.mesh.setMatrixAt(s, this._m);
      n = Math.max(n, s + 1);
      this._tag(id, p);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.aWalk.needsUpdate = true;
  }

  /** 머리 위 이름표를 화면 좌표로 옮긴다 */
  _tag(id, p) {
    let el = this.tags.get(id);
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'position:absolute;transform:translate(-50%,-100%);white-space:nowrap;' +
        'font-size:12px;color:#eaf2ff;text-shadow:0 1px 3px #000,0 0 8px #000;' +
        'background:rgba(8,14,24,.5);border-radius:5px;padding:2px 7px';
      // ★ innerHTML 로 넣으면 남이 지은 이름이 그대로 실행된다. 반드시 textContent.
      el.textContent = p.name;
      this.layer.appendChild(el);
      this.tags.set(id, el);
    } else if (el.textContent !== p.name) {
      el.textContent = p.name;
    }
    this._v.set(p.cx, p.cy + 0.42, p.cz);
    const d = this._v.distanceTo(this.camera.position);
    this._v.project(this.camera);
    // 카메라 뒤에 있거나 너무 멀면 숨긴다
    const behind = this._v.z > 1;
    if (behind || d > 320) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.style.left = ((this._v.x * 0.5 + 0.5) * innerWidth) + 'px';
    el.style.top = ((-this._v.y * 0.5 + 0.5) * innerHeight) + 'px';
    el.style.opacity = String(d > 180 ? 0.35 : d > 90 ? 0.7 : 1);
  }
}

let _mat = null;
function avatarMaterial(uniforms) {
  if (_mat) return _mat;
  _mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute float aPart;
      attribute vec3 aTint;
      attribute float aWalk;
      varying vec3 vN, vTint; varying float vPart;
      ${SCENE_PARS}
      void main(){
        vPart = aPart; vTint = aTint;
        // 걸은 거리로 걸음걸이 위상을 만든다 — 멈추면 다리도 멈춘다(시간으로 하면 제자리걸음)
        float gait = sin(aWalk * 4.0);
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
        vec4 wp = instanceMatrix * vec4(lp, 1.0);
        vec3 rn = mat3(instanceMatrix) * normal;
        vN = normalize(rn);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vN, vTint; varying float vPart;
      ${SCENE_PARS}
      ${COMMON}
      ${SHADE}
      void main(){
        vec3 base = (vPart > 0.5 && vPart < 1.5) ? vec3(0.30,0.24,0.20) : vTint;
        vec3 col = shadeNight(normalize(vN), base);
        col += base * vec3(1.0,0.66,0.34) * 0.36 * uArtificial;
        // 군중 속에서 눈에 띄어야 하므로 스스로도 조금 빛난다
        col += base * 0.22;
        vec3 vd = normalize(vWorld - cameraPosition);
        float rim = pow(1.0 - abs(dot(normalize(vN), vd)), 3.0);
        col += vec3(0.8,0.9,1.0) * rim * 0.10;
        ${FOG_APPLY}
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col,1.0);
      }`,
    side: THREE.DoubleSide,
  });
  return _mat;
}
