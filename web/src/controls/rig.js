// 카메라 조작. 세 가지 시점.
//   둘러보기(orbit) : 지도처럼 위에서 궤도 회전
//   걷기(walk)      : 눈높이 1.68m, 벽 통과 안 됨
//   비행(fly)       : 아무 데나 자유 이동

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CFG } from '../config.js';

export class CameraRig {
  constructor(camera, dom, chunks) {
    this.camera = camera;
    this.dom = dom;
    this.chunks = chunks;
    this.mode = 'orbit';
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0;
    this.locked = false;
    this.vel = new THREE.Vector3();

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
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    dom.addEventListener('click', () => {
      if (this.mode !== 'orbit' && !this.locked) dom.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    });
  }

  setMode(m) {
    if (m === this.mode) return;
    const prev = this.mode;
    this.mode = m;
    this.orbit.enabled = (m === 'orbit');
    if (m === 'orbit') {
      if (document.pointerLockElement) document.exitPointerLock();
      // 지금 보고 있던 지점을 중심으로 궤도 전환
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const t = this.camera.position.clone().add(dir.multiplyScalar(120));
      t.y = 0;
      this.orbit.target.copy(t);
      if (prev === 'walk') this.camera.position.y = Math.max(60, this.camera.position.y);
    } else {
      // 현재 카메라 방향을 yaw/pitch 로 옮겨 담는다
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.yaw = e.y; this.pitch = e.x;
      if (m === 'walk') this.camera.position.y = CFG.eyeHeight;
    }
    document.querySelectorAll('.btns button').forEach(b => b.classList.remove('on'));
    const el = document.getElementById('m-' + m);
    if (el) el.classList.add('on');
  }

  update(dt) {
    if (this.mode === 'orbit') { this.orbit.update(); return; }

    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));

    const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const sp = this.mode === 'fly' ? CFG.flySpeed * (run ? 3 : 1)
                                   : (run ? CFG.runSpeed : CFG.walkSpeed);
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(f);
    if (this.keys.has('KeyS')) move.sub(f);
    if (this.keys.has('KeyD')) move.add(r);
    if (this.keys.has('KeyA')) move.sub(r);
    if (this.mode === 'fly') {
      if (this.keys.has('KeyE') || this.keys.has('Space')) move.y += 1;
      if (this.keys.has('KeyQ')) move.y -= 1;
      // 비행에서는 시선 방향으로 전진
      if (this.keys.has('KeyW') || this.keys.has('KeyS')) {
        const look = new THREE.Vector3();
        this.camera.getWorldDirection(look);
        move.y += look.y * (this.keys.has('KeyW') ? 1 : -1);
      }
    }
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(sp * dt);

    if (this.mode === 'walk') {
      const p = this.camera.position;
      // 이미 건물 안에 들어와 있으면 모든 방향이 막혀 영영 못 나온다.
      // 그럴 때는 충돌 검사를 건너뛰어 빠져나올 수 있게 한다.
      const stuck = this.chunks.insideBuilding(p.x, p.z);
      // 축별로 나눠 밀어서 벽을 따라 미끄러지게 한다
      const nx = p.x + move.x;
      if (stuck || !this.chunks.insideBuilding(nx, p.z)) p.x = nx;
      const nz = p.z + move.z;
      if (stuck || !this.chunks.insideBuilding(p.x, nz)) p.z = nz;
      p.y = CFG.eyeHeight;
    } else {
      this.camera.position.add(move);
      this.camera.position.y = Math.max(1.2, this.camera.position.y);
    }
  }
}
