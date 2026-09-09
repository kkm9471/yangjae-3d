// 양재역 야경 3D — 시작점
//
// 사진·이미지·폰트 파일을 하나도 쓰지 않는다.
// 지도(OpenStreetMap)의 좌표만 받아서, 나머지는 전부 코드로 그린다.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { CFG, applyDeviceTier } from './config.js';
import { makeSceneUniforms } from './util/glsl.js';
import { ChunkManager } from './core/chunkManager.js';
import { buildBuildingMesh } from './build/buildings.js';
import { buildRoadMesh } from './build/roads.js';
import { createBaseGround, buildAreaMesh } from './build/ground.js';
import { buildPropsMesh } from './build/props.js';
import { buildSignMesh, atlas } from './build/signs.js';
import { buildPeopleMesh } from './build/people.js';
import { buildCarsMesh } from './build/cars.js';
import { createSky } from './night/sky.js';
import { applyTime, fmtHour, sunTimes } from './night/daycycle.js';
import { CameraRig } from './controls/rig.js';
import { TouchControls, isTouchDevice } from './controls/touch.js';
import { Minimap } from './ui/minimap.js';
import { Foley } from './audio/foley.js';

const boot = document.getElementById('boot');
const bootBar = boot.querySelector('.bar i');
const bootMsg = document.getElementById('bootmsg');
const errBox = document.getElementById('err');

window.__errors = 0;
function fail(msg, e) {
  window.__errors++;
  console.error(msg, e);
  errBox.style.display = 'block';
  errBox.textContent = `문제가 생겼습니다:\n${msg}\n${e ? (e.stack || e.message || e) : ''}`;
  boot.style.display = 'none';
}
addEventListener('error', ev => fail('실행 중 오류', ev.error || ev.message));
addEventListener('unhandledrejection', ev => fail('비동기 오류', ev.reason));

const Q = new URLSearchParams(location.search);

async function main() {
  bootMsg.textContent = '지도 데이터 목록 읽는 중…';

  // ── 어느 동네를 볼 것인가 ──
  let places = { default: 'yangjae', places: [] };
  try {
    places = await (await fetch('./data/places.json', { cache: 'no-store' })).json();
  } catch (e) { /* 목록이 없으면 기본 동네만 */ }
  const slug = Q.get('place') || places.default || 'yangjae';
  const dataBase = `./data/places/${slug}`;
  const placeRec = (places.places || []).find(p => p.slug === slug);

  const index = await (await fetch(`${dataBase}/index.json`, { cache: 'no-store' })).json();
  // 격자 크기는 데이터가 정한다. JS에 손으로 박아 두면 config.py 를 바꾸는 순간
  // 가로등·사람·차가 조용히 사라진다.
  if (index.chunkSize) CFG.chunkSize = index.chunkSize;
  bootBar.style.width = '15%';

  // ── 렌더러 ──
  // 폰이면 먼저 연출 밀도를 낮춘다. 청크를 만들기 전에 정해야 효과가 있다.
  const tier = applyDeviceTier(Q.get('perf'));
  const renderer = new THREE.WebGLRenderer({
    antialias: tier === 'high', powerPreference: 'high-performance',
    preserveDrawingBuffer: Q.has('shot'),
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, CFG.maxPixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CFG.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;   // 후처리 패스까지 합쳐서 세려면 수동 리셋
  document.body.appendChild(renderer.domElement);

  // 그래픽카드가 잠깐 끊기면(절전·드라이버 리셋) 화면이 그대로 굳는다.
  // 아무 말도 없으면 "느린가?" 하고 계속 기다리게 되므로 알려 준다.
  renderer.domElement.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    fail('그래픽이 잠시 끊겼습니다', new Error('브라우저를 새로고침(F5)하면 됩니다.'));
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.35, 6000);
  camera.position.set(-150, 190, 260);

  // ── 모든 재질이 공유하는 값 ──
  const U = makeSceneUniforms(THREE, CFG);
  U.uFloorH = { value: CFG.floorH };
  U.uGroundFloorH = { value: CFG.groundFloorH };

  scene.add(createSky(U));
  scene.add(createBaseGround(U, 24000));

  // ── 청크 빌더 등록 ──
  const builders = [
    { key: 'area', group: 'area', fn: (c, u) => buildAreaMesh(c, u) },
    { key: 'road', group: 'road', fn: (c, u) => buildRoadMesh(c, u) },
    { key: 'bld', group: 'osm', fn: (c, u) => buildBuildingMesh((c.buildings || []).filter(b => !b.gen), u) },
    { key: 'bldgen', group: 'gen', fn: (c, u) => buildBuildingMesh((c.buildings || []).filter(b => b.gen), u) },
    // near: true → 카메라 근처 청크에만 만든다(멀어지면 걷어낸다)
    { key: 'pool', group: 'pool', fn: (c, u) => buildPropsMesh(c, u, { geom: false, pools: true }) },
    { key: 'prop', group: 'prop', near: true, fn: (c, u) => buildPropsMesh(c, u, { geom: true, pools: false }) },
    { key: 'sign', group: 'sign', near: true, fn: (c, u) => buildSignMesh(c, u) },
    { key: 'people', group: 'people', near: true, fn: (c, u) => buildPeopleMesh(c, u) },
    { key: 'car', group: 'car', near: true, fn: (c, u) => buildCarsMesh(c, u) },
  ];
  const chunks = new ChunkManager(scene, U, index, builders, dataBase);
  window.__chunks = chunks;

  // ── 후처리(빛 번짐) ──
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight),
    CFG.bloom.strength, CFG.bloom.radius, CFG.bloom.threshold);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  if (Q.get('nobloom') === '1') bloom.enabled = false;

  // ── 조작 ──
  const rig = new CameraRig(camera, renderer.domElement, chunks);
  rig.setMode('orbit');
  document.getElementById('m-orbit').onclick = () => rig.setMode('orbit');
  // 걷기·비행 버튼은 누르는 즉시 1인칭 조작으로 들어간다
  // (예전에는 버튼을 눌러도 화면을 한 번 더 클릭해야 해서 '안 되는 줄' 알기 쉬웠다)
  document.getElementById('m-walk').onclick = () => { rig.setMode('walk'); rig.lock(); foley.setEnabled(soundOn); };
  document.getElementById('m-fly').onclick = () => { rig.setMode('fly'); rig.lock(); };
  document.getElementById('m-auto').onclick = () => { rig.toggleAuto(); foley.setEnabled(soundOn); };

  // ── 동네 고르기 / 주소로 새 동네 만들기 ──
  {
    const gid = (i) => document.getElementById(i);
    const sel = gid('placesel');
    const list = (places.places || []).slice();
    if (!list.length) list.push({ slug, name: (placeRec && placeRec.name) || slug });
    sel.innerHTML = '';
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.slug;
      o.textContent = p.name + (p.buildings ? '  (건물 ' + p.buildings.toLocaleString() + ')' : '');
      if (p.slug === slug) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { location.search = '?place=' + encodeURIComponent(sel.value); };

    const qEl = gid('q'), goEl = gid('qgo'), msgEl = gid('qmsg');
    const setMsg = (t, bad) => { msgEl.textContent = t; msgEl.classList.toggle('err', !!bad); };

    let polling = null;
    const poll = async () => {
      try {
        const j = await (await fetch('./__job', { cache: 'no-store' })).json();
        setMsg(j.message || '…', j.state === 'error');
        if (j.state === 'done' && j.slug) {
          clearInterval(polling);
          setMsg('완료! 화면을 새로 엽니다…');
          setTimeout(() => { location.search = '?place=' + encodeURIComponent(j.slug); }, 700);
        } else if (j.state === 'error') {
          clearInterval(polling);
          goEl.disabled = false;
        }
      } catch (e) { /* 잠깐 실패는 무시 */ }
    };

    const go = async () => {
      const q = qEl.value.trim();
      if (!q) { setMsg('주소나 지명을 적어 주세요.', true); return; }
      goEl.disabled = true;
      setMsg('요청하는 중…');
      try {
        const r = await fetch('./__build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) {
          setMsg(j.error || '이 서버는 동네 만들기를 지원하지 않습니다. 실행.bat 으로 다시 열어 주세요.', true);
          goEl.disabled = false;
          return;
        }
        if (polling) clearInterval(polling);
        polling = setInterval(poll, 700);
        poll();
      } catch (e) {
        setMsg('서버에 연결하지 못했습니다. 실행.bat 으로 다시 열어 주세요.', true);
        goEl.disabled = false;
      }
    };
    goEl.onclick = go;
    qEl.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  // ── 패널 접기 (걸어 다닐 때 화면을 가리지 않게) ──
  const titleEl = document.getElementById('hudtitle');
  titleEl.firstChild.textContent = ((placeRec && placeRec.name) || '양재역 사거리') + ' · 24시간 ';
  const hudEl = document.getElementById('hud');
  const toggleHud = () => hudEl.classList.toggle('mini');
  document.getElementById('hudtitle').onclick = toggleHud;
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyH' && !e.ctrlKey && !e.altKey && !e.metaKey) toggleHud();
  });

  // ── 미니맵 ──
  const mapCv = document.getElementById('minimap');
  const minimap = new Minimap(mapCv, chunks);

  // ── 소리 (파일 없이 합성) ──
  const foley = new Foley();
  let soundOn = false;
  rig.onStep = (sp) => foley.step(sp);

  // ── 명소 ──
  function goSpot(sp) {
    if (!sp) return;
    if (sp.r) {
      CFG.viewRadius = sp.r;
      const el0 = document.getElementById('vd');
      if (el0) { el0.value = String(sp.r); document.getElementById('vd-v').textContent = sp.r + ' m'; }
    }
    rig.setMode(sp.mode || 'walk');
    camera.position.set(sp.cam[0], sp.cam[1], sp.cam[2]);
    chunks.resetFocus();          // 순간이동은 부드럽게 따라가지 말고 즉시
    const t = new THREE.Vector3(sp.look[0], sp.look[1], sp.look[2]);
    camera.lookAt(t);
    rig.orbit.target.copy(t);
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    rig.yaw = e.y; rig.pitch = e.x;
  }
  const spotBox = document.getElementById('spots');
  (index.spots || []).forEach((sp, i) => {
    const btn = document.createElement('button');
    btn.textContent = sp.name;
    btn.onclick = () => goSpot(sp);
    spotBox.appendChild(btn);
  });
  window.__spots = index.spots || [];

  // ── URL 로 시점 지정(자동 검증용) ──
  // ?autowalk=1 — 자동 산책으로 시작(검증·시연용)
  if (Q.get('autowalk') === '1') setTimeout(() => { rig.setMode('walk'); rig.auto = true; rig._syncAutoBtn(); }, 300);
  if (Q.has('spot')) {
    const key = Q.get('spot');
    const sp = /^\d+$/.test(key) ? (index.spots || [])[Number(key)]
                                : (index.spots || []).find(s => s.name === key);
    goSpot(sp);
  }
  if (Q.has('cam')) {
    const [x, y, z] = Q.get('cam').split(',').map(Number);
    camera.position.set(x, y, z);
  }
  if (Q.has('look')) {
    const [x, y, z] = Q.get('look').split(',').map(Number);
    rig.orbit.target.set(x, y, z);
    camera.lookAt(x, y, z);
  }
  if (Q.has('mode')) rig.setMode(Q.get('mode'));
  // ?hide=sign,gen,prop  — 원인 추적용으로 특정 종류만 끄기
  if (Q.has('hide')) {
    for (const g of Q.get('hide').split(',')) {
      if (chunks.groups[g]) chunks.groups[g].visible = false;
      const cb = document.getElementById('t-' + g);
      if (cb) cb.checked = false;
    }
  }
  if (Q.has('r')) CFG.viewRadius = Number(Q.get('r'));

  // ── 시각 ──
  let hour = Q.has('hour') ? Number(Q.get('hour')) : 20.5;   // 기본은 밤 8시 반
  let autoTime = false;
  let litManual = false;
  const HOURS_PER_SEC = 24 / 150;        // 자동 흐름: 하루가 2분 30초

  // ── HUD ──
  const el = id => document.getElementById(id);
  const bind = (id, fn) => { const e = el(id); if (e) e.onchange = () => fn(e); };
  bind('t-gen', e => { chunks.groups.gen.visible = e.checked; });
  bind('t-sign', e => { if (chunks.groups.sign) chunks.groups.sign.visible = e.checked; });
  bind('t-people', e => { chunks.groups.people.visible = e.checked; });
  bind('t-car', e => { chunks.groups.car.visible = e.checked; });
  bind('t-bloom', e => { bloom.enabled = e.checked; });
  bind('t-sound', e => { soundOn = e.checked; foley.setEnabled(soundOn); });
  bind('t-map', e => { document.getElementById('nav').style.display = e.checked ? 'flex' : 'none'; });
  bind('t-bob', e => { CFG.bobScale = e.checked ? 1 : 0; });
  bind('t-gen', e => { minimap.showGen = e.checked; });
  const vd = el('vd'); vd.oninput = () => {
    CFG.viewRadius = Number(vd.value); el('vd-v').textContent = vd.value + ' m';
  };
  const lit = el('lit'); lit.oninput = () => {
    litManual = true;
    U.uLitRatio.value = Number(lit.value) / 100; el('lit-v').textContent = lit.value + '%';
  };
  const hrEl = el('hr');
  hrEl.value = String(hour);
  hrEl.oninput = () => { hour = Number(hrEl.value); litManual = false; };
  el('t-auto').onchange = (e) => { autoTime = e.target.checked; };
  {
    const st = sunTimes();
    el('sun-v').textContent = `${fmtHour(st.rise)} 뜸 · ${fmtHour(st.set)} 짐`;
  }

  // 화면 크기·화각이 바뀌면 '한 화소가 몇 m인지'도 바뀐다
  function updatePixelScale() {
    const s = new THREE.Vector2();
    renderer.getDrawingBufferSize(s);
    U.uPixelScale.value = 2 * Math.tan(camera.fov * 0.5 * Math.PI / 180) / Math.max(1, s.y);
  }
  updatePixelScale();

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    updatePixelScale();
  });

  // ── 첫 화면이 준비될 때까지 미리 청크를 채운다 ──
  bootMsg.textContent = '건물을 짓는 중…';
  chunks.buildBudgetMs = 1e9;                 // 처음에는 예산 제한 없이
  for (let i = 0; i < 400; i++) {
    const f0 = chunks.focusOf(camera);
    chunks.update(f0, CFG.viewRadius);
    bootBar.style.width = (15 + 80 * Math.min(1, chunks.stats.built / Math.max(1, chunks.neededKeys(f0, CFG.viewRadius).length))) + '%';
    if (chunks.isSettled(f0, CFG.viewRadius)) break;
    await new Promise(r => setTimeout(r, 25));
  }
  chunks.buildBudgetMs = 9;
  bootBar.style.width = '100%';
  boot.style.opacity = '0';
  setTimeout(() => { boot.style.display = 'none'; }, 500);

  // ── 서버에게 "아직 보고 있다" 신호 ──
  // 이 신호가 3분간 끊기면 서버가 스스로 꺼진다.
  // (창 없이 띄우기 때문에, 안 그러면 보이지 않는 서버가 계속 살아남는다)
  const ping = () => fetch('./__ping', { cache: 'no-store' }).catch(() => {});
  ping();
  setInterval(ping, 20000);

  const COMPASS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  const dirTmp = new THREE.Vector3();
  let navAcc = 0;

  // ── 자동 순회(검증용) ──
  // 카메라를 계속 움직여 청크가 실제로 로드·해제되게 만든다.
  // 정지 화면 스크린샷으로는 '버릴 때 터지는 버그'를 절대 못 잡는다.
  const TOUR = Q.get('tour') === '1';
  let tourT = 0;

  // ── 루프 ──
  const clock = new THREE.Clock();
  let acc = 0, frames = 0, fps = 0;
  const mPerDegLat = index.mPerDegLat, mPerDegLon = index.mPerDegLon;
  const o = index.origin;

  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, clock.getDelta());
    U.uTime.value += dt;

    // ── 시각 반영 ──
    if (autoTime) {
      hour = (hour + dt * HOURS_PER_SEC) % 24;
      hrEl.value = String(hour.toFixed(2));
    }
    const sky = applyTime(hour, U, bloom, renderer, { litManual });
    el('hr-v').textContent = fmtHour(hour);
    if (!litManual) el('lit').value = String(Math.round(U.uLitRatio.value * 100));
    el('lit-v').textContent = Math.round(U.uLitRatio.value * 100) + '%';

    if (TOUR) {
      tourT += dt;
      const a = tourT * 0.35;
      camera.position.set(Math.cos(a) * 260, 40 + 22 * Math.sin(a * 0.8), Math.sin(a) * 260);
      camera.lookAt(0, 12, 0);
    } else {
      rig.update(dt);
    }
    const focus = chunks.focusOf(camera);
    chunks.update(focus, CFG.viewRadius);

    // ── 미니맵·현재 위치 안내 ──
    minimap.setRange(rig.mode === 'walk' ? 170 : Math.max(180, CFG.viewRadius * 0.75));
    minimap.update(dt, camera);

    navAcc += dt;
    if (navAcc > 0.2) {
      navAcc = 0;
      const p2 = camera.position;
      const rn = chunks.roadNameAt(p2.x, p2.z);
      el('road-v').textContent = rn || '이름 없는 길';
      const dv = camera.getWorldDirection(dirTmp);
      const brg = (Math.atan2(dv.x, -dv.z) * 180 / Math.PI + 360) % 360;
      el('dir-v').textContent = `${COMPASS[Math.round(brg / 45) % 8]} ${Math.round(brg)}°`;

      const walkish = rig.mode !== 'orbit';
      document.getElementById('cross').style.display = walkish ? 'block' : 'none';
      const lookEl = document.getElementById('look');
      const hit = walkish ? chunks.lookingAt(camera) : null;
      if (hit && hit.b.name) {
        el('look-v').textContent = `${hit.b.name}  ·  ${Math.round(hit.dist)}m`;
        lookEl.style.display = 'block';
      } else {
        lookEl.style.display = 'none';
      }
      // 큰길에 가까울수록 도시 소음이 커진다
      if (soundOn) {
        const ns = chunks.nearestRoadSeg(p2.x, p2.z);
        const lv = ns ? Math.max(0, 1 - ns.dist / 70) * (ns.sg.half > 8 ? 1 : 0.45) : 0;
        foley.setAmbience(lv);
      }
    }

    // 간판 글자 아틀라스가 바뀌었으면 이때 한 번만 GPU로 올린다
    const A = atlas();
    if (A.dirty) { A.tex.needsUpdate = true; A.dirty = false; }

    renderer.info.reset();
    composer.render();

    acc += dt; frames++;
    if (acc > 0.4) {
      fps = frames / acc; acc = 0; frames = 0;
      const p = camera.position;
      el('fps').textContent = fps.toFixed(0);
      el('pos').textContent = `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} m`;
      el('ll').textContent = `${(o.lat - p.z / mPerDegLat).toFixed(5)}, ${(o.lon + p.x / mPerDegLon).toFixed(5)}`;
      el('nb').textContent = chunks.stats.buildings.toLocaleString();
      el('ns').textContent = chunks.stats.signs.toLocaleString();
      el('nc').textContent = `${chunks.stats.built} / ${chunks.available.size}`
        + (chunks.stats.failed ? `  ⚠못읽음 ${chunks.stats.failed}` : '');
      el('dc').textContent = renderer.info.render.calls;
      el('npc').textContent = `${chunks.stats.people.toLocaleString()} · ${chunks.stats.cars.toLocaleString()}`;
    }
    window.__fps = fps;
    window.__ready = chunks.isSettled(focus, CFG.viewRadius);
  }
  tick();

  window.__walkState = () => ({
    mode: rig.mode, auto: rig.auto,
    x: +camera.position.x.toFixed(1), y: +camera.position.y.toFixed(2), z: +camera.position.z.toFixed(1),
    ground: +rig.groundY.toFixed(3), walked: +rig.walked.toFixed(1),
    road: chunks.roadNameAt(camera.position.x, camera.position.z),
  });

  window.__stats = () => ({
    errors: window.__errors,
    failedChunks: chunks.stats.failed,
    signOverflow: atlas().overflow,
    fps: Math.round(window.__fps || 0),
    calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    chunks: chunks.stats.built,
    buildings: chunks.stats.buildings,
    signs: chunks.stats.signs,
    people: chunks.stats.people,
    cars: chunks.stats.cars,
  });
}

main().catch(e => fail('시작하지 못했습니다', e));
