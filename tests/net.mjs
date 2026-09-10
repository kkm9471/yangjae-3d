// 실시간 서버가 규칙대로 움직이는지 시험한다.
//
// 확인하는 것:
//   · 같은 동네 사람의 움직임이 전해지는가
//   · ★ 다른 동네 사람은 안 보이는가 (여기가 조용히 깨지기 쉽다.
//      해운대에 있는 사람이 양재 한복판에 유령처럼 서 있게 된다)
//   · 동네를 옮기면 옛 동네에서 사라지고 새 동네에 나타나는가
//   · 누가 어느 동네에 있는지 목록이 오는가
//   · 나가면 사라지는가
//   · 이상한 값(NaN·긴 이름·태그)을 보내도 서버가 안 죽는가
//
// 미리 띄워 둘 것:  cd server && npx wrangler dev --port 8788 --local
// 사용법:           node tests/net.mjs

const URL_WS = process.env.WS || 'ws://127.0.0.1:8788/ws';

const fail = [];
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) fail.push(msg);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 받은 메시지를 전부 모아 두는 접속자 */
function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_WS);
    const got = [];
    ws.addEventListener('message', e => { try { got.push(JSON.parse(e.data)); } catch { /* */ } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      label, ws, got,
      send: o => ws.send(JSON.stringify(o)),
      of: t => got.filter(m => m.t === t),
      clear: () => { got.length = 0; },
      close: () => ws.close(),
    }));
    setTimeout(() => reject(new Error(label + ' 접속 시간초과')), 8000);
  });
}

console.log('서버:', URL_WS);
const a = await connect('가');
const b = await connect('나');
const c = await connect('다');
await sleep(300);

console.log('\n[접속]');
ok(a.of('me').length === 1 && a.of('me')[0].id, '내 번호를 받음', a.of('me')[0]?.id);
const idA = a.of('me')[0].id, idB = b.of('me')[0].id, idC = c.of('me')[0].id;
ok(idA !== idB && idB !== idC, '사람마다 번호가 다름', `${idA} ${idB} ${idC}`);

// 가·나는 양재, 다는 해운대
a.send({ t: 'hi', name: '가나다', slug: 'yangjae' });
b.send({ t: 'hi', name: '나나나', slug: 'yangjae' });
c.send({ t: 'hi', name: '다다다', slug: 'haeundae' });
await sleep(400);

console.log('\n[같은 동네]');
ok(a.of('join').some(m => m.id === idB), '같은 동네 사람이 들어온 걸 알림');
ok(b.of('join').some(m => m.id === idA), '먼저 있던 사람도 보임');
ok(!a.of('join').some(m => m.id === idC), '다른 동네 사람은 안 보임');

// 움직여 본다
a.clear(); b.clear(); c.clear();
a.send({ t: 'p', x: 12.5, y: 1.68, z: -30.25, yaw: 1.2, st: 1 });
await sleep(300);
console.log('\n[움직임 전달]');
const pb = b.of('p')[0];
ok(!!pb, '같은 동네 사람에게 전달됨');
ok(pb && pb.id === idA && pb.x === 12.5 && pb.z === -30.25, '좌표가 그대로 전달됨',
  pb ? `x=${pb.x} z=${pb.z} st=${pb.st}` : '');
ok(c.of('p').length === 0, '★ 다른 동네에는 전달되지 않음');
ok(a.of('p').length === 0, '내 움직임이 나에게 되돌아오지 않음');

// 이상한 값
a.clear(); b.clear();
a.send({ t: 'p', x: 'NaN', y: null, z: 1e9, yaw: Infinity, st: 99 });
await sleep(250);
const weird = b.of('p')[0];
console.log('\n[이상한 값 방어]');
ok(!!weird, '서버가 안 죽음');
ok(weird && Number.isFinite(weird.x) && Number.isFinite(weird.yaw), '숫자가 아닌 값은 숫자로 고침',
  weird ? `x=${weird.x} yaw=${weird.yaw}` : '');
ok(weird && Math.abs(weird.z) <= 20000, '터무니없는 좌표는 잘림', weird ? `z=${weird.z}` : '');
ok(weird && [0, 1, 2].includes(weird.st), '상태값이 정해진 범위 안', weird ? `st=${weird.st}` : '');

// 동네 옮기기
a.clear(); b.clear(); c.clear();
a.send({ t: 'place', slug: 'haeundae' });
await sleep(400);
console.log('\n[동네 옮기기]');
ok(b.of('left').some(m => m.id === idA), '옛 동네에서 사라짐');
ok(c.of('join').some(m => m.id === idA), '새 동네에 나타남');

// 누가 어디 있나
console.log('\n[누가 어디 있나]');
const where = [...a.of('where')].pop();
ok(!!where && Array.isArray(where.people), '목록이 옴');
if (where) {
  const byId = Object.fromEntries(where.people.map(p => [p.id, p]));
  ok(where.people.length === 3, '세 명 다 있음', `${where.people.length}명`);
  ok(byId[idA]?.slug === 'haeundae' && byId[idB]?.slug === 'yangjae', '각자 동네가 맞음',
    where.people.map(p => `${p.name}@${p.slug}`).join(' '));
}

// 이름 다듬기 — 남이 지은 이름을 그대로 화면에 올리면 안 된다
const d = await connect('라');
await sleep(150);
d.send({ t: 'hi', name: '<script>alert(1)</script>아주아주아주긴이름', slug: 'yangjae' });
await sleep(400);
const wd = [...b.of('where')].pop();
const dRec = wd?.people.find(p => p.id === d.got.find(m => m.t === 'me')?.id);
console.log('\n[이름 다듬기]');
ok(!!dRec, '들어옴');
ok(dRec && !/[<>]/.test(dRec.name), '꺾쇠 같은 위험한 글자를 지움', dRec ? `"${dRec.name}"` : '');
ok(dRec && dRec.name.length <= 12, '이름 길이 제한', dRec ? `${dRec.name.length}자` : '');

// 나가기
b.clear();
d.close();
await sleep(500);
console.log('\n[나가기]');
ok(b.of('left').length > 0, '나간 사람이 사라짐');

a.close(); b.close(); c.close();
await sleep(200);
console.log(fail.length ? `\n❌ 실패 ${fail.length}건: ${fail.join(', ')}` : '\n✅ 실시간 서버 전부 통과');
process.exit(fail.length ? 1 : 0);
