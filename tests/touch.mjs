// 폰 조작이 실제로 되는지 시험한다.
//
// 아이폰이 여기 없으므로 크롬의 아이폰 흉내내기로 대신한다. 이걸로 알 수 있는 것:
//   · 터치 기기로 인식되는가(조이스틱 UI가 나오는가)
//   · 왼쪽을 밀면 진짜로 앞으로 걷는가
//   · 오른쪽을 문지르면 진짜로 고개가 돌아가는가
//   · 세로 화면에서 화각이 넓어지는가
// 알 수 없는 것: 실제 아이폰 사파리의 성능과 사파리 고유 문제. 그건 기기에서 열어 봐야 한다.
//
// 사용법: node tests/touch.mjs [기기이름]      예) node tests/touch.mjs "iPhone 12 Pro"

import puppeteer, { KnownDevices } from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = process.env.PORT || 8765;
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('tests/shots');
fs.mkdirSync(OUT, { recursive: true });

const deviceName = process.argv[2] || 'iPhone 12 Pro';
const device = KnownDevices[deviceName];
if (!device) { console.error('그런 기기 없음:', deviceName); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.emulate(device);

const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

const url = `${BASE}/index.html?shot=1&spot=0&hour=20`;
console.log(`기기: ${deviceName}  화면 ${device.viewport.width}x${device.viewport.height}`);
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__ready)); i++) {
  await new Promise(r => setTimeout(r, 500));
}

const fail = [];
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!cond) fail.push(msg);
};

// ── 1) 터치 기기로 알아봤는가 ──
const env = await page.evaluate(() => ({
  touchClass: document.body.classList.contains('touch'),
  coarse: matchMedia('(hover: none) and (pointer: coarse)').matches,
  diag: window.__diag ? window.__diag() : null,
  helpHidden: getComputedStyle(document.getElementById('help')).display === 'none',
  touchHelp: getComputedStyle(document.getElementById('touchhelp')).display !== 'none',
  hudOpen: !document.getElementById('hud').classList.contains('mini'),
}));
const getComputedStyleHudOpen = () => env.hudOpen;
console.log('\n[기기 인식]');
ok(env.coarse, '손가락 기기로 인식(pointer: coarse)');
ok(env.touchClass, 'body.touch 붙음 → 키보드 안내 숨김');
ok(env.helpHidden && env.touchHelp, '조작 안내가 터치용으로 바뀜');
ok(env.diag?.tier === 'low', '성능 등급이 낮춰짐',
  `tier=${env.diag?.tier} 반경=${env.diag?.viewRadius}m 화소비율=${env.diag?.pixelRatio}`);
const portrait = device.viewport.height > device.viewport.width;
ok(portrait ? env.diag?.fov > 60 : env.diag?.fov === 58,
  portrait ? '세로 화면이라 화각을 넓힘' : '가로 화면은 기본 화각 그대로',
  `fov=${env.diag?.fov}`);
ok(!getComputedStyleHudOpen(), '패널이 접혀 있어 조이스틱 자리를 막지 않음');

// ── 2) 걷기 모드로 바꾸고 왼쪽을 밀어 본다 ──
await page.evaluate(() => document.getElementById('m-walk').click());
await new Promise(r => setTimeout(r, 400));

const before = await page.evaluate(() => window.__walkState());
const W = device.viewport.width, H = device.viewport.height;

// 왼쪽 아래에 손가락을 대고 위로 민다 = 앞으로 걷기
await page.touchscreen.touchStart(W * 0.22, H * 0.72);
await new Promise(r => setTimeout(r, 60));
await page.touchscreen.touchMove(W * 0.22, H * 0.72 - 70);
await new Promise(r => setTimeout(r, 1400));           // 1.4초 걷는다
const stickShown = await page.evaluate(() =>
  getComputedStyle(document.getElementById('stick')).display !== 'none');
await page.touchscreen.touchEnd();
await new Promise(r => setTimeout(r, 300));

const afterMove = await page.evaluate(() => window.__walkState());
const dist = Math.hypot(afterMove.x - before.x, afterMove.z - before.z);
console.log('\n[왼쪽 = 이동]');
ok(stickShown, '민 자리에 조이스틱이 나타남');
ok(dist > 2, '앞으로 걸어감', `${dist.toFixed(1)}m 이동`);

// 손을 뗀 뒤에는 멈춰야 한다(iOS 에서 pointercancel 로 손가락을 놓치면 계속 걷는다)
const stopA = await page.evaluate(() => window.__walkState());
await new Promise(r => setTimeout(r, 700));
const stopB = await page.evaluate(() => window.__walkState());
ok(Math.hypot(stopB.x - stopA.x, stopB.z - stopA.z) < 0.6, '손을 떼면 멈춤');

// ── 3) 오른쪽을 문질러 시점 ──
const yaw0 = await page.evaluate(() => window.__walkState().yaw);
await page.touchscreen.touchStart(W * 0.75, H * 0.5);
await new Promise(r => setTimeout(r, 60));
await page.touchscreen.touchMove(W * 0.75 - 120, H * 0.5);
await new Promise(r => setTimeout(r, 200));
await page.touchscreen.touchEnd();
await new Promise(r => setTimeout(r, 200));
const yaw1 = await page.evaluate(() => window.__walkState().yaw);
console.log('\n[오른쪽 = 시점]');
ok(Math.abs(yaw1 - yaw0) > 0.2, '고개가 돌아감', `${((yaw1 - yaw0) * 180 / Math.PI).toFixed(0)}도`);

// ── 4) 화면이 정상인가 ──
await new Promise(r => setTimeout(r, 1200));
const stats = await page.evaluate(() => window.__stats());
const file = path.join(OUT, `phone_${deviceName.replace(/\s+/g, '_')}.png`);
await page.screenshot({ path: file });
const px = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const g = document.createElement('canvas'); g.width = 90; g.height = 160;
  const ctx = g.getContext('2d'); ctx.drawImage(c, 0, 0, 90, 160);
  const d = ctx.getImageData(0, 0, 90, 160).data;
  let sum = 0, nb = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += v; if (v > 12) nb++;
  }
  return { avg: +(sum / (d.length / 4)).toFixed(1), nonBlackPct: +(100 * nb / (d.length / 4)).toFixed(1) };
});
console.log('\n[화면]');
ok(stats.errors === 0 && stats.failedChunks === 0, '오류 없음',
  `errors=${stats.errors} failedChunks=${stats.failedChunks}`);
ok(px.nonBlackPct > 50, '까만 화면이 아님', `밝은 화소 ${px.nonBlackPct}%`);
console.log('  통계:', JSON.stringify(stats));
console.log('  저장:', file);

const bad = logs.filter(l => /error|pageerror/i.test(l));
if (bad.length) { console.log('\n로그(문제):'); bad.slice(0, 10).forEach(l => console.log('  ' + l)); }

await browser.close();
console.log(fail.length ? `\n❌ 실패 ${fail.length}건: ${fail.join(', ')}` : '\n✅ 폰 조작 전부 통과');
process.exit(fail.length ? 1 : 0);
