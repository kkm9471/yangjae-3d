// 청크 로더.
//
// 지도를 100m 격자로 쪼개 두었기 때문에, 카메라 근처만 만들고 멀어지면 버린다.
// 지금은 300m라 전부 올려도 되지만, 나중에 범위를 넓혀도 구조를 갈아엎지 않으려고
// 처음부터 이 방식으로 짓는다.

import * as THREE from 'three';
import { CFG } from '../config.js';

const ST_NONE = 0, ST_LOADING = 1, ST_LOADED = 2, ST_BUILT = 3;

// 가까운 청크에만 만드는 것들(간판·사람·차·설치물)의 기준 거리(m)
export const NEAR_DIST = 260;

export class ChunkManager {
  constructor(scene, uniforms, index, builders) {
    this.scene = scene;
    this.uniforms = uniforms;
    this.index = index;
    this.builders = builders;           // [{key, group, fn}]
    this.cs = index.chunkSize;
    this.chunks = new Map();            // "cx_cz" -> record
    this.groups = {};
    for (const b of builders) {
      if (!this.groups[b.group]) {
        const g = new THREE.Group();
        g.name = b.group;
        scene.add(g);
        this.groups[b.group] = g;
      }
    }
    this.available = new Set(index.chunks.map(c => `${c.cx}_${c.cz}`));
    this.inflight = 0;
    this.maxInflight = 8;
    this.buildBudgetMs = 9;             // 한 프레임에 이만큼만 만든다(끊김 방지)
    this.nearDist = NEAR_DIST;
    this.stats = { loaded: 0, built: 0, tris: 0, buildings: 0, signs: 0, people: 0, cars: 0 };
    // 걷기 충돌용: 건물 외곽선을 격자에 담아둔다
    this.collGrid = new Map();
    this.collCell = 25;
  }

  key(cx, cz) { return `${cx}_${cz}`; }

  _rec(cx, cz) {
    const k = this.key(cx, cz);
    let r = this.chunks.get(k);
    if (!r) { r = { k, cx, cz, state: ST_NONE, data: null, meshes: [], nearMeshes: [], near: false }; this.chunks.set(k, r); }
    return r;
  }

  /** 카메라가 실제로 '보고 있는 땅'을 기준으로 청크를 고른다.
      높은 데서 내려다볼 때 카메라 발밑이 아니라 화면 중앙을 채워야 한다. */
  focusOf(camera) {
    const p = camera.position;
    if (p.y > 20) {
      const d = new THREE.Vector3();
      camera.getWorldDirection(d);
      if (d.y < -0.12) {
        const t = Math.min(-p.y / d.y, 1500);
        return new THREE.Vector3(p.x + d.x * t, 0, p.z + d.z * t);
      }
    }
    return new THREE.Vector3(p.x, 0, p.z);
  }

  neededKeys(camPos, radius) {
    const cs = this.cs;
    const r = radius;
    const x0 = Math.floor((camPos.x - r) / cs), x1 = Math.floor((camPos.x + r) / cs);
    const z0 = Math.floor((camPos.z - r) / cs), z1 = Math.floor((camPos.z + r) / cs);
    const out = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this.key(cx, cz);
        if (!this.available.has(k)) continue;
        // 청크 중심까지 거리
        const dx = (cx + 0.5) * cs - camPos.x, dz = (cz + 0.5) * cs - camPos.z;
        const d = Math.hypot(dx, dz);
        if (d > r + cs) continue;
        out.push({ cx, cz, k, d });
      }
    }
    out.sort((a, b) => a.d - b.d);      // 가까운 것부터
    return out;
  }

  update(camPos, radius) {
    const need = this.neededKeys(camPos, radius);
    const needSet = new Set(need.map(n => n.k));

    // 1) 멀어진 것 버리기
    const keep = radius + CFG.chunkKeepMargin;
    for (const [k, r] of this.chunks) {
      if (needSet.has(k)) continue;
      const dx = (r.cx + 0.5) * this.cs - camPos.x, dz = (r.cz + 0.5) * this.cs - camPos.z;
      if (Math.hypot(dx, dz) > keep) this._unload(r);
    }

    // 2) 로드 시작
    for (const n of need) {
      if (this.inflight >= this.maxInflight) break;
      const r = this._rec(n.cx, n.cz);
      if (r.state !== ST_NONE) continue;
      this._load(r);
    }

    // 3) 만들기(프레임 예산 안에서). 가까운 것부터.
    const t0 = performance.now();
    for (const n of need) {
      const r = this.chunks.get(n.k);
      if (!r) continue;
      if (r.state === ST_LOADED) {
        this._build(r, n.d <= this.nearDist);
        if (performance.now() - t0 > this.buildBudgetMs) break;
      } else if (r.state === ST_BUILT) {
        // 멀리 있던 청크가 가까워지면 그때 연출을 얹는다(그 반대면 걷어낸다)
        const wantNear = n.d <= this.nearDist;
        if (wantNear && !r.near) {
          this._buildNear(r);
          if (performance.now() - t0 > this.buildBudgetMs) break;
        } else if (!wantNear && r.near && n.d > this.nearDist + 60) {
          this._dropNear(r);
        }
      }
    }
  }

  async _load(r) {
    r.state = ST_LOADING;
    this.inflight++;
    try {
      const res = await fetch(`./data/chunks/${r.k}.json`, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      r.data = await res.json();
      r.state = ST_LOADED;
      this.stats.loaded++;
    } catch (e) {
      console.warn('청크 로드 실패', r.k, e);
      r.state = ST_NONE;
      this.available.delete(r.k);       // 없는 청크는 다시 시도하지 않는다
    } finally {
      this.inflight--;
    }
  }

  _make(r, b, into) {
    let mesh = null;
    try { mesh = b.fn(r.data, this.uniforms, r); }
    catch (e) { console.error(`청크 ${r.k} / ${b.key} 생성 실패`, e); }
    if (!mesh) return;
    mesh.userData.chunk = r.k;
    this.groups[b.group].add(mesh);
    into.push(mesh);
    this.stats.tris += mesh.userData.tris || 0;
    for (const k of ['signs', 'people', 'cars']) {
      if (mesh.userData[k]) this.stats[k] += mesh.userData[k];
    }
  }

  _build(r, near) {
    r.state = ST_BUILT;
    for (const b of this.builders) {
      if (b.near) continue;
      this._make(r, b, r.meshes);
    }
    if (near) this._buildNear(r);
    for (const bd of (r.data.buildings || [])) this._addColl(bd);
    this.stats.buildings += (r.data.buildings || []).length;
    this.stats.built++;
  }

  /** 가까운 청크에만 얹는 연출(간판·설치물·사람·차) */
  _buildNear(r) {
    if (r.near || !r.data) return;
    r.near = true;
    for (const b of this.builders) {
      if (!b.near) continue;
      this._make(r, b, r.nearMeshes);
    }
  }

  _dropNear(r) {
    if (!r.near) return;
    r.near = false;
    for (const m of r.nearMeshes) this._disposeMesh(m);
    r.nearMeshes = [];
  }

  _disposeMesh(m) {
    m.parent && m.parent.remove(m);
    this.stats.tris -= m.userData.tris || 0;
    for (const k of ['signs', 'people', 'cars']) {
      if (m.userData[k]) this.stats[k] -= m.userData[k];
    }
    // ★ 가로등·나무 묶음은 Group 이라 geometry 가 없다.
    //   m.geometry.dispose() 를 그냥 부르면 카메라가 움직여 청크를 버리는 순간 터진다.
    //   (정지 화면 스크린샷으로는 절대 안 잡히는 종류의 버그였다)
    m.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }

  _unload(r) {
    for (const m of r.meshes) this._disposeMesh(m);
    for (const m of r.nearMeshes) this._disposeMesh(m);
    r.nearMeshes = [];
    r.near = false;
    if (r.state === ST_BUILT) {
      this.stats.built--;
      this.stats.buildings -= (r.data.buildings || []).length;
      for (const bd of (r.data.buildings || [])) this._delColl(bd);
    }
    if (r.state >= ST_LOADED) this.stats.loaded--;
    r.meshes = [];
    r.data = null;
    r.state = ST_NONE;
  }

  // ── 걷기 충돌 ──
  _cellsOf(poly) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (const p of poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    const c = this.collCell, out = [];
    for (let gx = Math.floor(x0 / c); gx <= Math.floor(x1 / c); gx++)
      for (let gz = Math.floor(z0 / c); gz <= Math.floor(z1 / c); gz++) out.push(`${gx}_${gz}`);
    return out;
  }
  _addColl(bd) {
    for (const k of this._cellsOf(bd.poly)) {
      let a = this.collGrid.get(k); if (!a) { a = []; this.collGrid.set(k, a); }
      a.push(bd.poly);
    }
  }
  _delColl(bd) {
    for (const k of this._cellsOf(bd.poly)) {
      const a = this.collGrid.get(k); if (!a) continue;
      const i = a.indexOf(bd.poly); if (i >= 0) a.splice(i, 1);
    }
  }
  /** 이 점이 건물 안인가? (걷기 모드에서 벽 통과 방지) */
  insideBuilding(x, z) {
    const c = this.collCell;
    const a = this.collGrid.get(`${Math.floor(x / c)}_${Math.floor(z / c)}`);
    if (!a) return false;
    for (const poly of a) {
      let inside = false;
      for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
        const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  /** 지금 보이는 범위가 전부 준비됐는가(스크린샷 검증용) */
  isSettled(camPos, radius) {
    if (this.inflight > 0) return false;
    for (const n of this.neededKeys(camPos, radius)) {
      const r = this.chunks.get(n.k);
      if (!r || r.state !== ST_BUILT) return false;
    }
    return true;
  }
}
