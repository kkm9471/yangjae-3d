// 인터넷에 올린 판(정적 호스팅)에서 제대로 도는지 시험한다.
//
// GitHub Pages 에는 파이썬 서버가 없다. 그래서 __ping / __build / __job 이 전부 404 다.
// 그때 화면이 "되는 척" 하면 안 된다 — 특히 주소 검색창이 멀쩡히 보이면
// 눌러 보고서야 안 된다는 걸 알게 된다.
//
// 미리 띄워 둘 것:  cd web && python -m http.server 8799 --bind 127.0.0.1
// 사용법:           node tests/static.mjs

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = process.env.PORT || 8799;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
const failed = [];
page.on('requestfailed', r => failed.push(r.url()));
const http404 = [];
page.on('response', r => { if (r.status() >= 400) http404.push(r.url()); });

await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1&spot=0&hour=20`,
  { waitUntil: 'networkidle2', timeout: 60000 });
for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__ready)); i++) {
  await new Promise(r => setTimeout(r, 500));
}
// 하트비트가 20초마다 다시 때리는지 보려면 그만큼 기다려야 한다.
// 여기서는 첫 판정(정적이라고 알아채는 것)만 확인하므로 3초면 넉넉하다.
await new Promise(r => setTimeout(r, 3000));

const fail = [];
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) fail.push(msg);
};

const s = await page.evaluate(() => ({
  qrowHidden: getComputedStyle(document.getElementById('qrow')).display === 'none',
  qmsg: document.getElementById('qmsg').textContent,
  qmsgErr: document.getElementById('qmsg').classList.contains('err'),
  places: [...document.getElementById('placesel').options].map(o => o.textContent.trim()),
  stats: window.__stats(),
}));

console.log('\n[정적 호스팅으로 알아봤는가]');
ok(s.qrowHidden, '주소 검색창을 숨김(눌러도 안 되는 걸 미리 알림)');
ok(!!s.qmsg && !s.qmsgErr, '대신 안내문이 보임', `"${s.qmsg}"`);

console.log('\n[동네 고르기]');
ok(s.places.length >= 2, '여러 동네를 고를 수 있음', `${s.places.length}곳`);
s.places.forEach(t => console.log('       ' + t));

console.log('\n[화면]');
ok(s.stats.errors === 0, '자바스크립트 오류 없음', `errors=${s.stats.errors}`);
ok(s.stats.failedChunks === 0, '못 받은 청크 없음', `failed=${s.stats.failedChunks}`);
ok(s.stats.buildings > 100, '건물이 그려짐', `${s.stats.buildings}동`);

// __ping 말고 다른 게 404 나면 배포가 잘못된 것이다
const bad404 = http404.filter(u => !/__ping|__job|__build/.test(u));
console.log('\n[요청]');
ok(bad404.length === 0, '없는 파일을 부르지 않음',
  bad404.length ? bad404.slice(0, 3).join(' ') : '');
const badFail = failed.filter(u => !/__ping|__job|__build/.test(u));
ok(badFail.length === 0, '실패한 요청 없음', badFail.slice(0, 3).join(' '));

await browser.close();
console.log(fail.length ? `\n❌ 실패 ${fail.length}건: ${fail.join(', ')}` : '\n✅ 정적 호스팅 전부 통과');
process.exit(fail.length ? 1 : 0);
