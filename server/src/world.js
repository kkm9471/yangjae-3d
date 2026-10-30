// 같이 돌아다니기 위한 실시간 서버 (Cloudflare Worker + Durable Object)
//
// 하는 일은 딱 하나다. **위치를 옮겨 주는 것.**
// 지도 데이터는 여기 없다 — 그건 GitHub Pages 에 정적 파일로 올라가 있고,
// 이 서버는 "누가 어디에 서 있는지"만 주고받는다. 그래서 아주 작고 싸다.
//
// 왜 Durable Object 인가:
//   보통 서버리스 함수는 요청마다 다른 곳에서 깨어나서 '누가 접속해 있는지'를 기억하지 못한다.
//   Durable Object 는 이름 하나당 전 세계에 딱 하나만 존재하는 객체라서,
//   접속자 목록을 메모리에 그냥 들고 있을 수 있다. 2025-04 부터 무료 플랜에도 포함됐다.
//
// 방을 동네별로 나누지 않고 하나만 쓴다. 사람이 몇 명 수준이라 그게 훨씬 단순하고,
// "지금 누가 어느 동네에 있는지"를 한 곳에서 알 수 있어야 서로를 찾아갈 수 있다.

const TICK_MS = 3000;          // 이 간격으로 "누가 어느 동네에 있나"를 알려 준다
const MAX_NAME = 12;           // 이름 길이 제한 (링크를 아는 사람은 누구나 들어온다)
const IDLE_MS = 45000;         // 이만큼 아무 소식 없으면 끊긴 것으로 본다
// 돈 상한 (2026-10-31): 주소가 공개돼 있어 누구나 붙을 수 있다. 정상 화면은 초당 8번 이하·한 번에 100바이트 남짓만 보낸다.
const MAX_PEERS = 30;          // 동시 접속 상한
const MAX_MSG = 1024;          // 메시지 한 개 크기 상한 (글자 수)
const RATE = 20, BURST = 40;   // 연결마다 초당 20개 (잠깐 몰아 보내기는 40개까지) — 넘으면 끊는다
// 접속 출처: 공개 사이트와 이 PC 로컬 서버(127.0.0.1·localhost)만. 출처 머리말이 없는 접속(시험 도구)은 그대로 받는다.
const ORIGIN_OK = /^(https:\/\/kkm9471\.github\.io|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;

/** 남이 지은 이름을 그대로 화면에 올리면 안 된다. 글자만 남기고 잘라 낸다. */
function cleanName(s) {
  if (typeof s !== 'string') return '손님';
  // 줄바꿈·제어문자·양옆 공백 제거 후 길이 제한
  const t = s.replace(/[\u0000-\u001f\u007f<>&"'\\]/g, '').trim().slice(0, MAX_NAME);
  return t || '손님';
}

/** 좌표는 숫자여야 한다. NaN 하나가 남의 화면을 통째로 망가뜨린다. */
function num(v, lo, hi) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

export class World {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.peers = new Map();       // ws → {id, name, slug, x, y, z, yaw, st, seen}
    this.nextId = 1;
    this.lastWhere = 0;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      // 살아 있는지 확인용
      return new Response(JSON.stringify({ ok: true, people: this.peers.size }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // 가득 찼으면 오래 조용한 연결부터 정리해 보고, 그래도 가득이면 받지 않는다
    if (this.peers.size >= MAX_PEERS) this.sendWhere(true);
    if (this.peers.size >= MAX_PEERS) return new Response('full', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const me = {
      id: 'p' + (this.nextId++), name: '손님', slug: '',
      x: 0, y: 1.68, z: 0, yaw: 0, st: 0, seen: Date.now(),
      tok: BURST, tt: Date.now(),
    };
    this.peers.set(server, me);

    server.addEventListener('message', ev => {
      // 이진·큰 메시지, 너무 잦은 메시지는 정상 화면이 보내지 않는다 → 끊는다
      const bad = typeof ev.data !== 'string' ? 1003 : ev.data.length > MAX_MSG ? 1009 : !this.allow(me) ? 1008 : 0;
      if (bad) { try { server.close(bad, 'limit'); } catch { /* 이미 닫힘 */ } this.drop(server, me); return; }
      try { this.onMessage(server, me, JSON.parse(ev.data)); } catch { /* 깨진 메시지는 무시 */ }
    });
    const gone = () => this.drop(server, me);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);

    this.send(server, { t: 'me', id: me.id });
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, me, m) {
    me.seen = Date.now();
    if (m.t === 'hi') {
      me.name = cleanName(m.name);
      me.slug = typeof m.slug === 'string' ? m.slug.slice(0, 40) : '';
      // 같은 동네 사람들에게 나를 알리고, 나에게는 그들을 알려 준다
      this.tellOthers(ws, me, { t: 'join', id: me.id, name: me.name });
      for (const [w, p] of this.peers) {
        if (w !== ws && p.slug === me.slug) {
          this.send(ws, { t: 'join', id: p.id, name: p.name });
        }
      }
      this.sendWhere(true);
      return;
    }
    if (m.t === 'place') {
      const next = typeof m.slug === 'string' ? m.slug.slice(0, 40) : '';
      if (next === me.slug) return;
      this.tellOthers(ws, me, { t: 'left', id: me.id });   // 옛 동네에서 사라지고
      me.slug = next;
      this.tellOthers(ws, me, { t: 'join', id: me.id, name: me.name });  // 새 동네에 나타난다
      for (const [w, p] of this.peers) {
        if (w !== ws && p.slug === me.slug) this.send(ws, { t: 'join', id: p.id, name: p.name });
      }
      this.sendWhere(true);
      return;
    }
    if (m.t === 'p') {
      me.x = num(m.x, -20000, 20000);
      me.y = num(m.y, -200, 4000);
      me.z = num(m.z, -20000, 20000);
      me.yaw = num(m.yaw, -100, 100);
      me.st = m.st === 2 ? 2 : m.st === 1 ? 1 : 0;
      // 같은 동네 사람에게만 보낸다. 다른 동네는 서로 다른 세계다.
      const msg = JSON.stringify({
        t: 'p', id: me.id,
        x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2),
        yaw: +me.yaw.toFixed(3), st: me.st,
      });
      for (const [w, p] of this.peers) {
        if (w !== ws && p.slug === me.slug) this.raw(w, msg);
      }
      this.sendWhere(false);
      return;
    }
  }

  /** 연결마다 초당 메시지 수 (토큰 통) */
  allow(me) {
    const now = Date.now();
    me.tok = Math.min(BURST, me.tok + (now - me.tt) / 1000 * RATE);
    me.tt = now;
    if (me.tok < 1) return false;
    me.tok -= 1;
    return true;
  }

  drop(ws, me) {
    if (!this.peers.has(ws)) return;
    this.peers.delete(ws);
    this.tellOthers(ws, me, { t: 'left', id: me.id });
    this.sendWhere(true);
  }

  /** 같은 동네의 다른 사람들에게만 */
  tellOthers(ws, me, obj) {
    const s = JSON.stringify(obj);
    for (const [w, p] of this.peers) {
      if (w !== ws && p.slug === me.slug) this.raw(w, s);
    }
  }

  /** "지금 누가 어느 동네에 있나" — 이게 없으면 서로 영영 못 만난다.
   *  1km² 짜리 동네가 여럿인데 순전히 우연에 맡기면 마주칠 일이 없다. */
  sendWhere(force) {
    const now = Date.now();
    if (!force && now - this.lastWhere < TICK_MS) return;
    this.lastWhere = now;

    // 오래 조용한 연결은 정리한다(브라우저가 그냥 죽으면 close 가 안 올 수 있다)
    for (const [w, p] of [...this.peers]) {
      if (now - p.seen > IDLE_MS) {
        try { w.close(1000, 'idle'); } catch { /* 이미 닫힘 */ }
        this.drop(w, p);
      }
    }

    const list = [];
    for (const p of this.peers.values()) list.push({ id: p.id, name: p.name, slug: p.slug });
    const s = JSON.stringify({ t: 'where', people: list });
    for (const w of this.peers.keys()) this.raw(w, s);
  }

  send(ws, obj) { this.raw(ws, JSON.stringify(obj)); }
  raw(ws, s) { try { ws.send(s); } catch { /* 끊긴 연결 */ } }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('ok', { headers: cors() });
    }
    if (url.pathname !== '/ws') {
      return new Response('여기는 위치만 주고받는 서버입니다. /ws 로 접속하세요.', {
        status: 404, headers: cors(),
      });
    }
    const origin = request.headers.get('Origin');
    if (origin && !ORIGIN_OK.test(origin)) return new Response('forbidden origin', { status: 403, headers: cors() });
    // 방 이름 하나만 쓴다. 사람이 몇 명 수준이라 나눌 이유가 없다.
    const id = env.WORLD.idFromName('world-v1');
    return env.WORLD.get(id).fetch(request);
  },
};

function cors() {
  return {
    'access-control-allow-origin': '*',
    'content-type': 'text/plain; charset=utf-8',
  };
}
