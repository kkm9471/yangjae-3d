// 실시간 서버를 Cloudflare 에 올리고, 그 주소를 화면 쪽 설정에 써 넣는다.
//
// 손으로 주소를 옮겨 적게 하면 오타 하나로 "왜 안 되지"가 된다.
// 그래서 올린 주소를 받아서 web/data/net.json 에 직접 써 넣고, 살아 있는지까지 확인한다.
//
// 사용법: node deploy.mjs        (server/ 안에서)

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NET = path.join(HERE, '..', 'web', 'data', 'net.json');

function run(cmd) {
  return execSync(cmd, { cwd: HERE, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
}

console.log('실시간 서버를 올리는 중…\n');
let out = '';
try {
  out = run('npx wrangler deploy');
} catch (e) {
  const txt = (e.stdout || '') + (e.stderr || '');
  console.error(txt);
  if (/not authenticated|wrangler login/i.test(txt)) {
    console.error('\n[먼저 할 일] Cloudflare 로그인이 안 돼 있습니다.');
    console.error('   server 폴더에서  npx wrangler login  을 실행하고');
    console.error('   브라우저가 열리면 Allow 를 누르세요. (무료 계정이면 됩니다)');
  }
  process.exit(1);
}
console.log(out);

// 올라간 주소를 찾는다
const m = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
if (!m) {
  console.error('[실패] 올라간 주소를 찾지 못했습니다. 위 메시지에서 workers.dev 주소를');
  console.error('       찾아 web/data/net.json 의 "ws" 에 직접 적어 주세요. (뒤에 /ws 를 붙일 것)');
  process.exit(1);
}
const https = m[0];
const ws = https.replace(/^https:/, 'wss:') + '/ws';

// 정말 살아 있는지 확인한다. "올렸다"는 말만 믿지 않는다.
process.stdout.write(`\n${https} 이 살아 있는지 확인하는 중… `);
let alive = false;
for (let i = 0; i < 10; i++) {
  try {
    const r = await fetch(https + '/health');
    if (r.ok && (await r.text()).trim() === 'ok') { alive = true; break; }
  } catch { /* 아직 퍼지는 중 */ }
  await new Promise(r => setTimeout(r, 3000));
}
console.log(alive ? '살아 있습니다.' : '응답이 없습니다.');
if (!alive) {
  console.error('[실패] 배포는 됐는데 응답이 없습니다. 잠시 뒤 다시 시도해 보세요.');
  process.exit(1);
}

const j = JSON.parse(fs.readFileSync(NET, 'utf8'));
j.ws = ws;
fs.writeFileSync(NET, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log(`\nweb/data/net.json 에 적었습니다:\n   ${ws}`);
console.log('\n이제 이걸 웹에도 반영하세요:');
console.log('   git add -A && git commit -m "실시간 서버 주소" && git push');
console.log('   (밀고 1분쯤 지나면 https://kkm9471.github.io/yangjae-3d/ 에 반영됩니다)');
