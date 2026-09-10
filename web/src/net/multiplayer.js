// 같이 돌아다니기 — 브라우저 쪽.
//
// 서버는 위치만 옮겨 준다(server/src/world.js). 여기서는
//   ① 내 위치를 초당 몇 번만 보내고
//   ② 남의 위치를 받아 부드럽게 이어 그린다
//
// ②가 중요하다. 초당 8번 온 좌표를 그대로 찍으면 상대가 순간이동하듯 딱딱 끊긴다.
// 받은 값은 '목표'로 두고 현재 위치를 그쪽으로 끌어당긴다.

const SEND_HZ = 8;              // 내 위치를 보내는 횟수 (초당)
const SMOOTH = 11;              // 남의 위치를 따라가는 빠르기 (클수록 즉각적이고 덜 부드럽다)
const RETRY_MAX = 15000;

export class Multiplayer {
  /**
   * @param {object} o
   * @param {string} o.url    ws 주소. 없으면 아예 동작하지 않는다(혼자 모드)
   * @param {string} o.name   내 이름
   * @param {string} o.slug   지금 있는 동네
   * @param {(list:Array)=>void} o.onPeople  접속자 목록이 바뀔 때
   * @param {(s:string)=>void}   o.onStatus  연결 상태가 바뀔 때
   */
  constructor(o) {
    this.url = o.url || '';
    this.name = o.name || '손님';
    this.slug = o.slug || '';
    this.onPeople = o.onPeople || (() => {});
    this.onStatus = o.onStatus || (() => {});

    this.peers = new Map();     // id → {name, x,y,z,yaw,st, cx,cy,cz,cyaw, walked}
    this.people = [];           // 서버가 알려 준 전체 접속자(동네 포함)
    this.myId = null;
    this.ws = null;
    this.state = 'off';         // off | 연결중 | 연결됨 | 끊김
    this._acc = 0;
    this._retry = 1000;
    this._closing = false;
    this._lastSent = null;
  }

  get enabled() { return !!this.url; }
  get here() { return this.peers.size; }        // 같은 동네에 있는 사람 수

  connect() {
    if (!this.url || this._closing) return;
    this._set('연결중');
    let ws;
    try { ws = new WebSocket(this.url); } catch { this._retryLater(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this._retry = 1000;
      this._set('연결됨');
      this._send({ t: 'hi', name: this.name, slug: this.slug });
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      this._onMsg(m);
    };
    ws.onclose = () => { this.ws = null; this._set('끊김'); this._retryLater(); };
    ws.onerror = () => { /* onclose 가 뒤따른다 */ };
  }

  close() {
    this._closing = true;
    if (this.ws) { try { this.ws.close(); } catch { /* */ } this.ws = null; }
  }

  _set(s) { if (this.state !== s) { this.state = s; this.onStatus(s); } }

  _retryLater() {
    if (this._closing || !this.url) return;
    setTimeout(() => this.connect(), this._retry);
    this._retry = Math.min(RETRY_MAX, this._retry * 2);
  }

  _send(o) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(o)); } catch { /* */ }
    }
  }

  _onMsg(m) {
    if (m.t === 'me') { this.myId = m.id; return; }
    if (m.t === 'join') {
      if (m.id === this.myId) return;
      if (!this.peers.has(m.id)) {
        this.peers.set(m.id, {
          name: m.name || '손님', x: 0, y: 1.68, z: 0, yaw: 0, st: 0,
          cx: 0, cy: 1.68, cz: 0, cyaw: 0, walked: 0, fresh: true,
        });
      } else {
        this.peers.get(m.id).name = m.name || '손님';
      }
      return;
    }
    if (m.t === 'left') { this.peers.delete(m.id); return; }
    if (m.t === 'p') {
      let p = this.peers.get(m.id);
      if (!p) {
        // join 을 놓쳤어도 위치가 오면 그려 준다(이름은 where 가 채워 준다)
        p = { name: '…', x: m.x, y: m.y, z: m.z, yaw: m.yaw, st: 0,
          cx: m.x, cy: m.y, cz: m.z, cyaw: m.yaw, walked: 0, fresh: true };
        this.peers.set(m.id, p);
      }
      p.x = m.x; p.y = m.y; p.z = m.z; p.yaw = m.yaw; p.st = m.st | 0;
      if (p.fresh) { p.cx = p.x; p.cy = p.y; p.cz = p.z; p.cyaw = p.yaw; p.fresh = false; }
      return;
    }
    if (m.t === 'where') {
      this.people = Array.isArray(m.people) ? m.people : [];
      // 이름 채우기
      for (const q of this.people) {
        const p = this.peers.get(q.id);
        if (p && q.name) p.name = q.name;
      }
      this.onPeople(this.people);
      return;
    }
  }

  /** 동네를 옮겼다 */
  setPlace(slug) {
    if (slug === this.slug) return;
    this.slug = slug;
    this.peers.clear();          // 저쪽 동네 사람들은 여기 없다
    this._send({ t: 'place', slug });
  }

  setName(name) {
    this.name = name;
    this._send({ t: 'hi', name, slug: this.slug });
  }

  /**
   * 매 프레임 부른다. 내 위치를 (가끔) 보내고, 남의 위치를 부드럽게 따라간다.
   * @param {number} dt 초
   * @param {{x,y,z,yaw,st}} me 내 상태
   */
  update(dt, me) {
    if (!this.url) return;

    // ── 내 위치 보내기 ──
    this._acc += dt;
    if (this._acc >= 1 / SEND_HZ) {
      this._acc = 0;
      const l = this._lastSent;
      // 가만히 서 있으면 보내지 않는다. 무료 한도는 '들어오는 메시지' 수로 계산되므로
      // 멈춰 있는 동안 계속 보내면 아무 일도 없는데 한도만 깎인다.
      const moved = !l || Math.abs(l.x - me.x) > 0.02 || Math.abs(l.z - me.z) > 0.02
        || Math.abs(l.y - me.y) > 0.05 || Math.abs(l.yaw - me.yaw) > 0.01 || l.st !== me.st;
      if (moved) {
        this._send({ t: 'p', x: me.x, y: me.y, z: me.z, yaw: me.yaw, st: me.st });
        this._lastSent = { x: me.x, y: me.y, z: me.z, yaw: me.yaw, st: me.st };
      }
    }

    // ── 남의 위치 따라가기 ──
    const k = Math.min(1, dt * SMOOTH);
    for (const p of this.peers.values()) {
      const before = p.cx, beforeZ = p.cz;
      p.cx += (p.x - p.cx) * k;
      p.cy += (p.y - p.cy) * k;
      p.cz += (p.z - p.cz) * k;
      // 각도는 -π~π 를 넘나들 때 반대로 돌지 않도록 짧은 쪽으로
      let d = p.yaw - p.cyaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      p.cyaw += d * k;
      // 실제로 움직인 거리만큼만 다리를 젓는다
      p.walked += Math.hypot(p.cx - before, p.cz - beforeZ);
    }
  }

  /** 같은 동네에 있는 사람 중 가장 가까운 사람 */
  nearest(x, z) {
    let best = null, bd = Infinity;
    for (const [id, p] of this.peers) {
      const d = Math.hypot(p.cx - x, p.cz - z);
      if (d < bd) { bd = d; best = { id, p, dist: d }; }
    }
    return best;
  }
}

/** 서버 주소를 알아낸다. 없으면 빈 문자열(= 혼자 모드). */
export async function netUrl(query) {
  const forced = query.get('ws');
  if (forced) return forced;
  try {
    const r = await fetch('./data/net.json', { cache: 'no-store' });
    if (!r.ok) return '';
    const j = await r.json();
    return typeof j.ws === 'string' ? j.ws : '';
  } catch {
    return '';
  }
}
