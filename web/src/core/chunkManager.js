// 청크 로더.
//
// 지도를 100m 격자로 쪼개 두었기 때문에, 카메라 근처만 만들고 멀어지면 버린다.
// 지금은 300m라 전부 올려도 되지만, 나중에 범위를 넓혀도 구조를 갈아엎지 않으려고
// 처음부터 이 방식으로 짓는다.

import * as THREE from 'three';
import { CFG } from '../config.js';

const ST_NONE = 0, ST_LOADING = 1, ST_LOADED = 2, ST_BUILT = 3;

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

// 가까운 청크에만 만드는 것들(간판·사람·차·설치물)의 기준 거리(m)
export const NEAR_DIST = 260;

export class ChunkManager {
  constructor(scene, uniforms, index, builders, base) {
    // base = 이 동네의 데이터 폴더 (예: ./data/places/yangjae)
    this.scene = scene;
    this.uniforms = uniforms;
    this.index = index;
    this.base = base || './data';
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
    this.stats = { loaded: 0, built: 0, tris: 0, buildings: 0, signs: 0, people: 0, cars: 0, failed: 0 };
    // 지도를 다시 만들면 주소가 바뀌어 브라우저가 옛 청크를 재사용하지 못한다
    this.ver = '?v=' + encodeURIComponent(String(index.builtAt || '0')).replace(/%20/g, '_');
    this._focus = null;
    // 걷기 충돌용: 건물 외곽선을 격자에 담아둔다
    this.collGrid = new Map();
    this.collCell = 25;
    // 걷기 지면용: 도로·보도 조각을 격자에 담아둔다
    // (보도 턱을 실제로 밟고 내려가는 느낌을 내려면 발밑 높이를 알아야 한다)
    this.groundGrid = new Map();
    this.groundCell = 25;
  }

  key(cx, cz) { return `${cx}_${cz}`; }

  _rec(cx, cz) {
    const k = this.key(cx, cz);
    let r = this.chunks.get(k);
    if (!r) {
      r = { k, cx, cz, state: ST_NONE, data: null, meshes: [], nearMeshes: [],
            near: false, gen: 0, fails: 0, dead: false, collAdded: false };
      this.chunks.set(k, r);
    }
    return r;
  }

  /** 카메라가 실제로 '보고 있는 땅'을 기준으로 청크를 고른다.
      높은 데서 내려다볼 때 카메라 발밑이 아니라 화면 중앙을 채워야 한다. */
  focusOf(camera) {
    const p = camera.position;
    const d = new THREE.Vector3();
    camera.getWorldDirection(d);

    // ★ 예전엔 시선각 -0.12 를 경계로 기준점이 '카메라 발밑'과 '1.5km 앞 땅'
    //   사이를 툭 튀어 다녔다. 마우스를 조금 내리는 것만으로 로드된 청크가
    //   한 프레임에 전부 해제돼 도시가 통째로 사라졌다(오류는 한 건도 안 남).
    //   → 각도에 따라 부드럽게 섞고, 거리도 보이는 범위에 맞춰 제한한다.
    let w = 0;
    if (p.y > 20 && d.y < -0.05) {
      const t0 = Math.min(1, ((-d.y) - 0.05) / 0.20);
      w = t0 * t0 * (3 - 2 * t0);
    }
    const maxT = Math.max(150, CFG.viewRadius * 1.1);
    const t = d.y < -0.02 ? Math.min(-p.y / d.y, maxT) : 0;
    const tx = p.x + d.x * t * w;
    const tz = p.z + d.z * t * w;

    if (!this._focus) this._focus = new THREE.Vector3(tx, 0, tz);
    else {
      this._focus.x += (tx - this._focus.x) * 0.15;
      this._focus.z += (tz - this._focus.z) * 0.15;
    }
    return this._focus;
  }

  /** 명소로 순간이동할 때는 부드럽게 따라가지 말고 즉시 옮긴다 */
  resetFocus() { this._focus = null; }

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
      if (r.state !== ST_NONE || r.dead) continue;
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
    const gen = ++r.gen;               // 이 요청의 세대번호
    this.inflight++;
    try {
      const res = await fetch(`${this.base}/chunks/${r.k}.json${this.ver}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // 기다리는 사이에 이 청크가 버려졌다면(카메라가 멀어짐) 늦게 온 응답은 버린다.
      // 안 그러면 같은 청크가 두 번 지어져 '보이지 않는 벽'이 남는다.
      if (gen !== r.gen) return;
      r.data = data;
      r.state = ST_LOADED;
      r.fails = 0;
      this.stats.loaded++;
    } catch (e) {
      if (gen !== r.gen) return;
      r.state = ST_NONE;
      r.fails++;
      // 한 번 실패했다고 목록에서 지우면 그 구역이 영구히 비고,
      // 게다가 '필요한 청크'에서도 빠져서 모든 계기판이 정상이라고 답한다.
      // → 몇 번 더 시도하고, 그래도 안 되면 실패로 세어 화면에 드러낸다.
      if (r.fails >= 4) {
        r.dead = true;
        this.stats.failed++;
        console.warn('청크를 4번 시도했지만 읽지 못했습니다:', r.k, e);
      }
    } finally {
      this.inflight--;
    }
  }

  _make(r, b, into) {
    let mesh = null;
    try { mesh = b.fn(r.data, this.uniforms, r); }
    catch (e) { console.error(`청크 ${r.k} / ${b.key} 생성 실패: ${e && e.message}`, e && e.stack); }
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
    if (!r.collAdded) {
      for (const bd of (r.data.buildings || [])) this._addColl(bd);
      this._addGround(r);
      r.collAdded = true;
    }
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
    m.traverse((o) => {
      const g = o.geometry;
      if (!g) return;
      // 사람·차 모형의 원본은 모든 청크가 함께 쓴다. 청크 하나를 버릴 때
      // 그걸 GPU에서 지우면 다른 청크의 사람·차까지 사라진다 → 떼어내고 버린다.
      if (o.userData.sharedBase) {
        for (const k of Object.keys(g.attributes)) {
          if (!g.attributes[k].isInstancedBufferAttribute) g.deleteAttribute(k);
        }
        g.index = null;
      }
      g.dispose();
    });
  }

  _unload(r) {
    r.gen++;                       // 진행 중인 로드 요청을 무효화한다
    for (const m of r.meshes) this._disposeMesh(m);
    for (const m of r.nearMeshes) this._disposeMesh(m);
    r.nearMeshes = [];
    r.near = false;
    if (r.collAdded) {
      for (const bd of ((r.data && r.data.buildings) || [])) this._delColl(bd);
      this._delGround(r);
      r.collAdded = false;
    }
    if (r.state === ST_BUILT) {
      this.stats.built--;
      this.stats.buildings -= ((r.data && r.data.buildings) || []).length;
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
      a.push(bd);
    }
  }
  _delColl(bd) {
    for (const k of this._cellsOf(bd.poly)) {
      const a = this.collGrid.get(k); if (!a) continue;
      const i = a.indexOf(bd); if (i >= 0) a.splice(i, 1);
    }
  }

  /** 이 점을 품고 있는 건물(이름·높이 포함). 없으면 null */
  buildingAt(x, z) {
    const c = this.collCell;
    const a = this.collGrid.get(`${Math.floor(x / c)}_${Math.floor(z / c)}`);
    if (!a) return null;
    for (const bd of a) if (pointInPoly(x, z, bd.poly)) return bd;
    return null;
  }

  /** 화면 한가운데가 가리키는 건물 (최대 140m 앞까지 훑는다) */
  lookingAt(camera) {
    const d = new THREE.Vector3();
    camera.getWorldDirection(d);
    const p = camera.position;
    const hx = Math.hypot(d.x, d.z);
    if (hx < 0.02) return null;
    const ux = d.x / hx, uz = d.z / hx;
    for (let t = 3; t < 140; t += 2.5) {
      const x = p.x + ux * t, z = p.z + uz * t;
      const y = p.y + (d.y / hx) * t;         // 그 거리에서의 시선 높이
      const bd = this.buildingAt(x, z);
      if (bd && bd.h > y) return { b: bd, dist: t };
    }
    return null;
  }
  // ── 발밑 지면 ──
  _groundCells(ax, az, bx, bz, pad) {
    const c = this.groundCell, out = [];
    const x0 = Math.floor((Math.min(ax, bx) - pad) / c), x1 = Math.floor((Math.max(ax, bx) + pad) / c);
    const z0 = Math.floor((Math.min(az, bz) - pad) / c), z1 = Math.floor((Math.max(az, bz) + pad) / c);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) out.push(`${gx}_${gz}`);
    return out;
  }

  _addGround(r) {
    const segs = [];
    for (const road of (r.data.roads || [])) {
      if (road.tunnel) continue;
      const y = 0.02 + (road.z || 1) * 0.007 + (road.layer || 0) * 5.5;
      const half = road.w / 2, sw = road.sw || 0;
      for (let i = 0; i < road.pts.length - 1; i++) {
        segs.push({ ax: road.pts[i][0], az: road.pts[i][1],
                    bx: road.pts[i + 1][0], bz: road.pts[i + 1][1],
                    half, sw, y, walk: false, name: road.name || '', cls: road.cls });
      }
    }
    for (const f of (r.data.footways || [])) {
      if (f.tunnel) continue;
      const y = 0.165 + (f.layer || 0) * 5.5;
      for (let i = 0; i < f.pts.length - 1; i++) {
        segs.push({ ax: f.pts[i][0], az: f.pts[i][1],
                    bx: f.pts[i + 1][0], bz: f.pts[i + 1][1],
                    half: 1.3, sw: 0, y, walk: true });
      }
    }
    r.groundSegs = segs;
    for (const sg of segs) {
      for (const k of this._groundCells(sg.ax, sg.az, sg.bx, sg.bz, sg.half + sg.sw + 1)) {
        let a = this.groundGrid.get(k); if (!a) { a = []; this.groundGrid.set(k, a); }
        a.push(sg);
      }
    }
  }

  _delGround(r) {
    for (const sg of (r.groundSegs || [])) {
      for (const k of this._groundCells(sg.ax, sg.az, sg.bx, sg.bz, sg.half + sg.sw + 1)) {
        const a = this.groundGrid.get(k); if (!a) continue;
        const i = a.indexOf(sg); if (i >= 0) a.splice(i, 1);
      }
    }
    r.groundSegs = null;
  }

  /** 이 점에서 가장 가까운 도로 조각 (자동 산책이 보도를 따라가는 데 쓴다) */
  nearestRoadSeg(x, z) {
    const c = this.groundCell;
    let best = null, bd = 1e9;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const a = this.groundGrid.get(`${Math.floor(x / c) + dx}_${Math.floor(z / c) + dz}`);
        if (!a) continue;
        for (const sg of a) {
          if (sg.walk) continue;
          const ux = sg.bx - sg.ax, uz = sg.bz - sg.az;
          const dd = ux * ux + uz * uz;
          const t = dd < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - sg.ax) * ux + (z - sg.az) * uz) / dd));
          const qx = sg.ax + ux * t, qz = sg.az + uz * t;
          const d = Math.hypot(x - qx, z - qz);
          if (d < bd) {
            const L = Math.sqrt(dd) || 1;
            // 어느 쪽에 서 있는가 (외적 부호)
            const side = ((x - sg.ax) * (uz / L) - (z - sg.az) * (ux / L)) > 0 ? -1 : 1;
            bd = d;
            best = { sg, t, qx, qz, dist: d, dirX: ux / L, dirZ: uz / L, side, len: L };
          }
        }
      }
    }
    return best;
  }

  /** 발밑 높이(m). 차도면 노면, 보도면 턱 위, 아무것도 없으면 맨땅. */
  groundAt(x, z) {
    const c = this.groundCell;
    let roadY = null, walkY = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const a = this.groundGrid.get(`${Math.floor(x / c) + dx}_${Math.floor(z / c) + dz}`);
        if (!a) continue;
        for (const sg of a) {
          const ux = sg.bx - sg.ax, uz = sg.bz - sg.az;
          const dd = ux * ux + uz * uz;
          const t = dd < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - sg.ax) * ux + (z - sg.az) * uz) / dd));
          const d = Math.hypot(x - (sg.ax + ux * t), z - (sg.az + uz * t));
          if (d <= sg.half) {
            if (roadY === null || sg.y > roadY) roadY = sg.y;
          } else if (sg.sw > 0.4 && d <= sg.half + sg.sw) {
            const wy = sg.y + 0.145;
            if (walkY === null || wy > walkY) walkY = wy;
          } else if (sg.walk && d <= sg.half + 0.6) {
            if (walkY === null || sg.y > walkY) walkY = sg.y;
          }
        }
      }
    }
    // 보도가 있으면 보도 위(턱을 밟고 올라선 상태), 없으면 차도, 둘 다 없으면 맨땅.
    // 지형이 있으면 '맨땅'은 평지 0.05m 가 아니라 그 자리의 산비탈 높이다.
    // (this.terrain 은 main.js 가 꽂아 준다. 지형 없는 동네에서는 예전과 똑같이 동작한다)
    if (walkY !== null) return walkY;
    if (roadY !== null) return roadY;
    if (this.terrain && this.terrain.ready) return this.terrain.heightAt(x, z) + 0.05;
    return 0.05;
  }

  /** 이 점이 건물 안인가? (걷기 모드에서 벽 통과 방지) */
  insideBuilding(x, z) {
    const c = this.collCell;
    const a = this.collGrid.get(`${Math.floor(x / c)}_${Math.floor(z / c)}`);
    if (!a) return false;
    for (const bd of a) if (pointInPoly(x, z, bd.poly)) return true;
    return false;
  }

  /** 지금 서 있는(또는 바로 옆) 도로 이름 */
  roadNameAt(x, z) {
    const n = this.nearestRoadSeg(x, z);
    if (!n) return '';
    if (n.dist > n.sg.half + Math.max(4, n.sg.sw) + 6) return '';
    return n.sg.name || '';
  }

  /** 지금 보이는 범위가 전부 준비됐는가(스크린샷 검증용) */
  isSettled(camPos, radius) {
    if (this.inflight > 0) return false;
    for (const n of this.neededKeys(camPos, radius)) {
      const r = this.chunks.get(n.k);
      if (!r) return false;
      if (r.dead) continue;              // 못 읽은 청크는 stats.failed 로 드러난다
      if (r.state !== ST_BUILT) return false;
    }
    return true;
  }
}
