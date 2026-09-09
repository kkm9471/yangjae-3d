// 카메라 조작. 세 가지 시점.
//   둘러보기(orbit) : 지도처럼 위에서 궤도 회전
//   걷기(walk)      : 1인칭. 눈높이 1.68m, 벽 통과 안 됨, 보도 턱을 밟고 오르내림
//   비행(fly)       : 아무 데나 자유 이동
//
// 걷기가 '걷는 것처럼' 느껴지려면 위치를 옮기는 것만으로는 부족하다.
//   ① 즉시 최고속도가 아니라 가속·감속이 있어야 하고
//   ② 걸음마다 시야가 위아래로 흔들려야 하고(head bob)
//   ③ 옆걸음일 때 몸이 살짝 기울어야 하고
//   ④ 발밑 높이가 보도/차도에 따라 달라져야 하고
//   ⑤ 사람은 점이 아니라 폭이 있어서 모서리에 어깨가 걸려야 한다.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CFG } from '../config.js';

const BODY_R = 0.34;          // 어깨 반지름(m)
const STEP_LEN = 0.78;        // 보폭(m) — 이 거리마다 발소리 한 번

export class CameraRig {
  constructor(camera, dom, chunks) {
    this.camera = camera;
    this.dom = dom;
    this.chunks = chunks;
    this.mode = 'orbit';
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0;
    this.locked = false;

    // 걷기 상태
    this.vel = new THREE.Vector3();     // 수평 속도(m/s)
    this.groundY = 0.165;               // 발밑 높이(부드럽게 따라감)
    this.walked = 0;                    // 걸은 거리 — 흔들림과 발소리의 기준
    this.strafeRoll = 0;
    this.auto = false;                  // 자동 산책
    this.autoYaw = 0;
    this.baseFov = camera.fov;
    this.onStep = null;                 // 발소리 콜백(main.js가 연결)
    this._lastStep = 0;

    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.075;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.minDistance = 12;
    this.orbit.maxDistance = 2400;
    this.orbit.target.set(0, 0, 0);

    addEventListener('keydown', e => {
      this.keys.add(e.code);
      if (e.code === 'Digit1') this.setMode('orbit');
      if (e.code === 'Digit2') this.setMode('walk');
      if (e.code === 'Digit3') this.setMode('fly');
      // 걷는 중에 방향키를 누르면 브라우저가 화면을 스크롤하는 걸 막는다
      if (this.locked && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD') {
        this.auto = false;              // 직접 조작하면 자동 산책은 멈춘다
        this._syncAutoBtn();
      }
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    dom.addEventListener('click', () => this.lock());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      this._syncHint();
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
      if (e.movementX || e.movementY) { this.auto = false; this._syncAutoBtn(); }
    });
  }

  /** 마우스를 화면에 가둔다(1인칭 시점 조작). 사용자 클릭에서만 부를 수 있다. */
  lock() {
    if (this.mode !== 'orbit' && !this.locked) {
      const r = this.dom.requestPointerLock();
      if (r && r.catch) r.catch(() => {});
    }
  }

  _syncHint() {
    const el = document.getElementById('lockhint');
    if (!el) return;
    el.style.display = (this.mode !== 'orbit' && !this.locked) ? 'block' : 'none';
  }
  _syncAutoBtn() {
    const b = document.getElementById('m-auto');
    if (b) b.classList.toggle('on', this.auto);
  }

  setMode(m) {
    if (m === this.mode) { this._syncHint(); return; }
    const prev = this.mode;
    this.mode = m;
    this.orbit.enabled = (m === 'orbit');
    this.auto = false;
    this._syncAutoBtn();
    if (m === 'orbit') {
      if (document.pointerLockElement) document.exitPointerLock();
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const t = this.camera.position.clone().add(dir.multiplyScalar(120));
      t.y = 0;
      this.orbit.target.copy(t);
      if (prev === 'walk') this.camera.position.y = Math.max(60, this.camera.position.y);
    } else {
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.yaw = e.y; this.pitch = e.x;
      if (m === 'walk') {
        this.vel.set(0, 0, 0);
        this.groundY = this.chunks.groundAt(this.camera.position.x, this.camera.position.z);
        this.camera.position.y = this.groundY + CFG.eyeHeight;
      }
    }
    document.querySelectorAll('#viewbtns button').forEach(b => b.classList.remove('on'));
    const el = document.getElementById('m-' + m);
    if (el) el.classList.add('on');
    this._syncHint();
  }

  /** 자동 산책 켜기/끄기 */
  toggleAuto() {
    if (this.mode !== 'walk') this.setMode('walk');
    this.auto = !this.auto;
    this._syncAutoBtn();
  }

  /** 어깨 폭까지 고려한 벽 검사 */
  _blocked(x, z) {
    const c = this.chunks;
    return c.insideBuilding(x, z)
        || c.insideBuilding(x + BODY_R, z) || c.insideBuilding(x - BODY_R, z)
        || c.insideBuilding(x, z + BODY_R) || c.insideBuilding(x, z - BODY_R);
  }

  /** 자동 산책: 가장 가까운 도로의 보도를 따라간다 */
  _autoSteer(p) {
    const n = this.chunks.nearestRoadSeg(p.x, p.z);
    if (!n) return null;
    const sg = n.sg;
    // 내가 서 있는 쪽 보도의 중심선
    const off = (sg.half + Math.max(1.6, sg.sw) * 0.5) * n.side;
    const nx = -n.dirZ, nz = n.dirX;          // 도로 진행방향의 오른쪽 법선
    const lineX = n.qx + nx * off, lineZ = n.qz + nz * off;
    // 지금 바라보는 방향과 같은 쪽으로 진행
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const along = (n.dirX * fx + n.dirZ * fz) >= 0 ? 1 : -1;
    // 앞을 얼마나 멀리 보느냐가 곧 '보도 중앙으로 얼마나 세게 붙느냐'다.
    // 멀리 보면 부드럽지만 차도로 흘러나가고, 가까이 보면 붙지만 갈지자로 걷는다.
    const err = Math.hypot(p.x - lineX, p.z - lineZ);
    const look = err > 3 ? 4 : 7;
    const tx = lineX + n.dirX * along * look, tz = lineZ + n.dirZ * along * look;
    return { x: tx, z: tz };
  }

  update(dt) {
    if (this.mode === 'orbit') { this.orbit.update(); return; }

    const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const p = this.camera.position;

    // ── 방향 결정 ──
    if (this.auto && this.mode === 'walk') {
      const t = this._autoSteer(p);
      if (t) {
        const want = Math.atan2(-(t.x - p.x), -(t.z - p.z));
        let d = want - this.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.yaw += d * Math.min(1, dt * 2.2);     // 부드럽게 방향 전환
        this.pitch += (-0.04 - this.pitch) * Math.min(1, dt * 1.5);
      }
    }

    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (this.auto && this.mode === 'walk') {
      wish.add(f);
    } else {
      if (this.keys.has('KeyW')) wish.add(f);
      if (this.keys.has('KeyS')) wish.sub(f);
      if (this.keys.has('KeyD')) wish.add(r);
      if (this.keys.has('KeyA')) wish.sub(r);
    }

    if (this.mode === 'fly') {
      // 비행은 예전 그대로: 즉각 반응이 편하다
      if (this.keys.has('KeyE') || this.keys.has('Space')) wish.y += 1;
      if (this.keys.has('KeyQ')) wish.y -= 1;
      if (this.keys.has('KeyW') || this.keys.has('KeyS')) {
        const look = new THREE.Vector3();
        this.camera.getWorldDirection(look);
        wish.y += look.y * (this.keys.has('KeyW') ? 1 : -1);
      }
      const sp = CFG.flySpeed * (run ? 3 : 1);
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(sp * dt);
      p.add(wish);
      p.y = Math.max(1.2, p.y);
      this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
      this._fov(dt, run ? 4 : 0);
      return;
    }

    // ── 걷기 ──
    const target = run ? CFG.runSpeed : CFG.walkSpeed;
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(target);
    // 사람은 즉시 최고속도가 되지 않는다. 멈출 때가 더 빠르다.
    const k = Math.min(1, dt * (wish.lengthSq() > 0 ? 7.5 : 11));
    this.vel.x += (wish.x - this.vel.x) * k;
    this.vel.z += (wish.z - this.vel.z) * k;

    const stuck = this.chunks.insideBuilding(p.x, p.z);
    const sx = this.vel.x * dt, sz = this.vel.z * dt;
    // 축을 나눠 밀어 벽을 따라 미끄러지게 한다
    if (stuck || !this._blocked(p.x + sx, p.z)) p.x += sx; else this.vel.x *= 0.2;
    if (stuck || !this._blocked(p.x, p.z + sz)) p.z += sz; else this.vel.z *= 0.2;

    // 발밑 높이 — 보도 턱을 밟고 오르내린다
    const gy = this.chunks.groundAt(p.x, p.z);
    this.groundY += (gy - this.groundY) * Math.min(1, dt * 8.5);

    // 걸음 흔들림
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.walked += speed * dt;
    const amp = Math.min(1, speed / CFG.walkSpeed);
    const ph = (this.walked / STEP_LEN) * Math.PI;
    const bobY = Math.abs(Math.sin(ph)) * 0.042 * amp - 0.021 * amp;
    const bobRoll = Math.sin(ph * 0.5) * 0.011 * amp;

    // 옆걸음이면 몸이 살짝 기운다
    const strafe = this.vel.x * r.x + this.vel.z * r.z;
    this.strafeRoll += (-strafe / CFG.runSpeed * 0.045 - this.strafeRoll) * Math.min(1, dt * 6);

    p.y = this.groundY + CFG.eyeHeight + bobY;
    this.camera.quaternion.setFromEuler(
      new THREE.Euler(this.pitch, this.yaw, bobRoll + this.strafeRoll, 'YXZ'));
    this._fov(dt, run && speed > 4 ? 5 : 0);

    // 발소리 — 보폭마다 한 번
    const stepIdx = Math.floor(this.walked / STEP_LEN);
    if (stepIdx !== this._lastStep) {
      this._lastStep = stepIdx;
      if (this.onStep && speed > 0.6) this.onStep(speed);
    }
  }

  _fov(dt, extra) {
    const want = this.baseFov + extra;
    if (Math.abs(this.camera.fov - want) < 0.02) return;
    this.camera.fov += (want - this.camera.fov) * Math.min(1, dt * 5);
    this.camera.updateProjectionMatrix();
  }
}
