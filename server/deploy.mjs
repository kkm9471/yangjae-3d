// 실시간 서버를 Cloudflare 에 올리고, 그 주소를 화면 쪽 설정에 써 넣는다.
//
// 손으로 주소를 옮겨 적게 하면 오타 하나로 "왜 안 되지"가 된다.
// 그래서 올린 주소를 받아서 web/data/net.json 에 직접 써 넣고, 살아 있는지까지 확인한다.
//
// ★ 주소를 받아내려면 wrangler 의 출력을 가로채야 하는데(pipe),
//   그러면 wrangler 가 "사람이 안 보고 있다"고 판단해서 물어볼 것을 못 묻는다.
//   계정에 workers.dev 이름을 아직 안 정했으면 바로 여기서 막힌다.
//   → 막히면 한 번은 가로채지 않고(inherit) 다시 돌려서, 직접 답할 수 있게 한다.
//
// 사용법: node deploy.mjs        (server/ 안에서)

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NET = path.join(HERE, '..', 'web', 'data', 'net.json');

/** 조용히 돌리고 출력을 돌려준다. 실패하면 {ok:false, out} */
function quiet(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: HERE, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** 화면에 그대로 띄우며 돌린다(사람이 답할 수 있게) */
function loud(cmd) {
  try {
    execSync(cmd, { cwd: HERE, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

console.log('실시간 서버를 올리는 중…\n');
let r = quiet('npx wrangler deploy');

// ── 계정에 workers.dev 이름이 아직 없을 때 ──
if (!r.ok && /workers\.dev subdomain/i.test(r.out)) {
  console.log('─'.repeat(60));
  console.log(' 이 Cloudflare 계정에 아직 "내 주소"가 없습니다.');
  console.log(' 계정마다 딱 한 번만 정하는 이름입니다. 예: kkm9471');
  console.log(' 아래에서 물어보면 원하는 이름을 적고 엔터를 누르세요.');
  console.log(' (그러면 서버 주소가 https://yangjae-world.<그이름>.workers.dev 가 됩니다)');
  console.log('─'.repeat(60) + '\n');
  loud('npx wrangler deploy');       // 이번엔 가로채지 않는다 → 물어볼 수 있다
  r = quiet('npx wrangler deploy');  // 주소를 받아내려고 한 번 더 (이미 올라가 있어 금방 끝난다)
}

if (!r.ok) {
  console.error(r.out);
  if (/not authenticated|wrangler login/i.test(r.out)) {
    console.error('\n[먼저 할 일] Cloudflare 로그인이 안 돼 있습니다.');
    console.error('   server 폴더에서  npx wrangler login  을 실행하고');
    console.error('   브라우저가 열리면 Allow 를 누르세요. (무료 계정이면 됩니다)');
  } else if (/workers\.dev subdomain/i.test(r.out)) {
    console.error('\n[먼저 할 일] 계정에 "내 주소"를 정해야 합니다.');
    console.error('   위 메시지에 있는 dash.cloudflare.com 링크를 브라우저로 열어');
    console.error('   원하는 이름을 하나 정한 뒤, 이 창을 다시 실행하세요.');
  }
  process.exit(1);
}
console.log(r.out);

// 올라간 주소를 찾는다
const m = r.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
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
    const res = await fetch(https + '/health');
    if (res.ok && (await res.text()).trim() === 'ok') { alive = true; break; }
  } catch { /* 아직 퍼지는 중 */ }
  await new Promise(z => setTimeout(z, 3000));
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
console.log('\n이제 이걸 웹에도 반영합니다…');
