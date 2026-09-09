// 화면을 실제로 띄워서 찍는다.
//
// "동작할 것이다"가 아니라 "동작하는 것을 눈으로 본다"를 위한 도구.
// 설치된 크롬을 헤드리스로 띄워 WebGL 화면을 캡처하고,
// 콘솔 오류·통계를 함께 뽑아 준다.
//
// 사용법: node tests/shot.mjs [이름] [쿼리스트링]
//   예)  node tests/shot.mjs aerial "cam=-160,320,340&look=0,0,0"

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = process.env.PORT || 8765;
const OUT = path.resolve('tests/shots');
fs.mkdirSync(OUT, { recursive: true });

const name = process.argv[2] || 'shot';
const query = process.argv[3] || '';
const W = Number(process.env.W || 1600), H = Number(process.env.H || 900);
const WAIT = Number(process.env.WAIT || 25000);

const url = `http://127.0.0.1:${PORT}/index.html?shot=1${query ? '&' + query : ''}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist',
    `--window-size=${W},${H}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', r => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

console.log('열기:', url);
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

// 화면이 다 준비될 때까지 기다린다
let ready = false;
const t0 = Date.now();
while (Date.now() - t0 < WAIT) {
  ready = await page.evaluate(() => !!window.__ready).catch(() => false);
  if (ready) break;
  await new Promise(r => setTimeout(r, 500));
}
// 블룸/애니메이션이 안정될 시간
await new Promise(r => setTimeout(r, 1500));

const stats = await page.evaluate(() => (window.__stats ? window.__stats() : null)).catch(() => null);
const err = await page.evaluate(() => {
  const e = document.getElementById('err');
  return e && e.style.display !== 'none' ? e.textContent : null;
}).catch(() => null);

const file = path.join(OUT, `${name}.png`);
await page.screenshot({ path: file });

// 화면이 정말 '까맣지 않은지' 픽셀로 확인한다 (조용한 실패 방지)
const px = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const g = document.createElement('canvas');
  g.width = 160; g.height = 90;
  const ctx = g.getContext('2d');
  ctx.drawImage(c, 0, 0, 160, 90);
  const d = ctx.getImageData(0, 0, 160, 90).data;
  let sum = 0, mx = 0, nonBlack = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += v; if (v > mx) mx = v; if (v > 12) nonBlack++;
  }
  return { avg: +(sum / (d.length / 4)).toFixed(1), max: mx, nonBlackPct: +(100 * nonBlack / (d.length / 4)).toFixed(1) };
});

console.log('준비완료:', ready);
console.log('통계:', JSON.stringify(stats));
console.log('픽셀:', JSON.stringify(px));
if (err) console.log('화면오류:\n' + err);
const bad = logs.filter(l => /error|pageerror|reqfail|실패/i.test(l));
if (bad.length) { console.log('로그(문제):'); bad.slice(0, 25).forEach(l => console.log('  ' + l)); }
console.log('저장:', file);

await browser.close();
process.exit(err || !ready ? 1 : 0);
