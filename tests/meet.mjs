// 두 사람이 실제로 만나지는지 시험한다.
//
// 브라우저 두 개를 진짜로 띄워서, 서로가 보이는지·움직임이 전해지는지·
// 다른 동네로 가면 사라지는지를 확인한다. 이게 이 기능의 전부다.
//
// 미리 띄워 둘 것:
//   1) cd server && npx wrangler dev --port 8788 --local
//   2) python tools/serve.py --stay          (지도 서버 8765)
// 사용법: node tests/meet.mjs

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = process.env.PORT || 8765;
const WS = process.env.WS === '' ? '' : (process.env.WS || 'ws://127.0.0.1:8788/ws');
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
// WS 를 빈 값으로 주면 ?ws= 를 안 붙인다 → 화면이 data/net.json 을 읽는
// 진짜 경로로 시험하게 된다(올려 둔 판을 검사할 때 이게 중요하다).
const OUT = path.resolve('tests/shots');
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) fail.push(msg);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ★ 사람마다 브라우저를 따로 띄운다.
//   한 브라우저에 탭 두 개로 하면, 뒤에 있는 탭의 requestAnimationFrame 을 크롬이 멈춘다.
//   그러면 위치 보간·아바타 갱신이 통째로 서 버려서, 멀쩡한 코드가 고장 난 것처럼 보인다.
//   (실제로 이 함정에 한 번 빠졌다. 웹소켓으로 오는 값만 맞고 화면만 안 움직였다)
const LAUNCH = {
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1200,760',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
};
const browsers = [];

async function open(name, place) {
  const browser = await puppeteer.launch(LAUNCH);
  browsers.push(browser);
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1200, height: 760 });
  await page.evaluateOnNewDocument(n => {
    try { localStorage.setItem('yangjae3d.name', n); } catch { /* */ }
  }, name);
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const url = `${BASE}/index.html?shot=1&spot=0&hour=20&place=${place}`
    + (WS ? `&ws=${encodeURIComponent(WS)}` : '');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__ready)); i++) await sleep(500);
  return { name, page, errs };
}

console.log('지도:', BASE, ' 실시간:', WS || '(data/net.json 에 적힌 것)');
const A = await open('가나', 'yangjae');
const B = await open('나다', 'yangjae');
// 둘 다 걷기 모드로. 둘러보기 모드에서는 OrbitControls 가 카메라를 제 자리로 되돌려서
// 옮겨 놓아도 소용이 없다(실제로 여기서 한 번 헤맸다).
for (const s of [A, B]) await s.page.evaluate(() => document.getElementById('m-walk').click());
await sleep(2500);

// ── 1) 서로를 알아보는가 ──
const a1 = await A.page.evaluate(() => window.__net());
const b1 = await B.page.evaluate(() => window.__net());
console.log('\n[서로 알아보기]');
ok(a1.on && a1.state === '연결됨', '가나 연결됨', a1.state);
ok(b1.on && b1.state === '연결됨', '나다 연결됨', b1.state);
ok(a1.name === '가나' && b1.name === '나다', '이름이 저장된 대로 들어감',
  `${a1.name} / ${b1.name}`);
ok(a1.here === 1, '가나 화면에 상대가 1명 있음', `${a1.here}명`);
ok(b1.here === 1, '나다 화면에 상대가 1명 있음', `${b1.here}명`);
ok(a1.peers[0]?.name === '나다', '상대 이름이 맞음', a1.peers[0]?.name);
ok(a1.people.length === 2, '접속자 목록에 두 명', `${a1.people.length}명`);

// ── 2) 가까이 붙이면 아바타와 이름표가 보이는가 ──
await A.page.evaluate(() => window.__teleport(-60, 10));
await B.page.evaluate(() => window.__teleport(-52, 10));
await sleep(2000);
const a2 = await A.page.evaluate(() => window.__net());
console.log('\n[아바타·이름표]');
ok(a2.avatarCount > 0, '아바타가 그려짐', `${a2.avatarCount}개`);
ok(a2.tags.includes('나다'), '머리 위 이름표가 보임', JSON.stringify(a2.tags));
ok(a2.peers[0] && Math.abs(a2.peers[0].x - (-52)) < 3, '상대 위치가 실제와 맞음',
  `x=${a2.peers[0]?.x} (기대 -52)`);
ok(!a2.near, '가까우면 방향 안내를 안 띄움(이름표와 겹침 방지)', a2.near || '(안 띄움)');

// ── 3) 움직이면 전해지는가 ──
await B.page.evaluate(() => window.__teleport(-52, 60));
await sleep(2000);
const a3 = await A.page.evaluate(() => window.__net());
console.log('\n[움직임]');
ok(a3.peers[0] && Math.abs(a3.peers[0].z - 60) < 6, '상대가 움직인 게 보임',
  `z=${a3.peers[0]?.z} (기대 60)`);
ok(a3.peers[0] && a3.peers[0].walked > 1, '다리를 저은 거리만큼 누적됨',
  `${a3.peers[0]?.walked}m`);
ok(!!a3.near, '멀어지면 어느 쪽에 있는지 알려 줌', a3.near || '(안 띄움)');

// 이 순간을 찍어 둔다 (사람이 눈으로 확인할 수 있게).
// 상대 쪽을 보게 하고, 화면 왼쪽 패널은 접는다 — 아바타가 실제로 보이는지가 요점이다.
await B.page.evaluate(() => window.__teleport(-66, 34));
await A.page.evaluate(() => {
  window.__teleport(-66, 20);
  window.__lookAt(-66, 34);
  document.getElementById('hud').classList.add('mini');
  // 헤드리스에는 포인터 잠금이 없어 "화면을 클릭하세요" 안내가 계속 떠 있다.
  // 사람에게 보여 줄 사진에서는 그게 아바타를 가린다.
  for (const id of ['lockhint', 'help', 'touchhelp']) {
    const e = document.getElementById(id); if (e) e.style.display = 'none';
  }
});
await sleep(2200);
const shot = path.join(OUT, 'meet.png');
await A.page.screenshot({ path: shot });
// 정말 그려졌는지 화소로 확인한다. 눈대중 대신 숫자로.
const look = await A.page.evaluate(() => {
  const c = document.querySelector('canvas');
  const g = document.createElement('canvas'); g.width = 160; g.height = 100;
  const ctx = g.getContext('2d'); ctx.drawImage(c, 0, 0, 160, 100);
  const d = ctx.getImageData(0, 0, 160, 100).data;
  let sum = 0, nb = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i+1] + d[i+2]) / 3; sum += v; if (v > 12) nb++;
  }
  return { avg: +(sum / (d.length/4)).toFixed(1), nonBlackPct: +(100*nb/(d.length/4)).toFixed(1) };
});
console.log('\n[화면에 실제로 보이는가]');
ok(look.nonBlackPct > 40, '까만 화면이 아님', `밝은 화소 ${look.nonBlackPct}% · 평균밝기 ${look.avg}`);

// ── 4) 다른 동네로 가면 사라지는가 ──
console.log('\n[다른 동네]');
const B2 = await open('나다', 'p351638_1291587');   // 해운대
await B.page.browser().close();
await sleep(2500);
const a4 = await A.page.evaluate(() => window.__net());
ok(a4.here === 0, '★ 다른 동네 사람은 세계에서 사라짐', `${a4.here}명`);
ok(a4.avatarCount === 0, '아바타도 치워짐', `${a4.avatarCount}개`);
ok(a4.tags.length === 0, '이름표도 치워짐', JSON.stringify(a4.tags));
ok(a4.people.some(p => p.slug === 'p351638_1291587'),
  '그래도 목록에는 "해운대에 있음"으로 남음',
  a4.people.map(p => `${p.name}@${p.slug}`).join(' '));

// ── 5) 오류 없이 버텼는가 ──
console.log('\n[오류]');
const st = await A.page.evaluate(() => window.__stats());
ok(A.errs.length === 0 && B2.errs.length === 0, '자바스크립트 오류 없음',
  [...A.errs, ...B2.errs].slice(0, 2).join(' | '));
ok(st.errors === 0, '화면 오류 없음', `errors=${st.errors}`);
console.log('  저장:', shot);

for (const b of browsers) await b.close();
console.log(fail.length ? `\n❌ 실패 ${fail.length}건: ${fail.join(', ')}` : '\n✅ 같이 돌아다니기 전부 통과');
process.exit(fail.length ? 1 : 0);
