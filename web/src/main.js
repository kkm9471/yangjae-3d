// 양재역 야경 3D — 시작점
//
// 사진·이미지·폰트 파일을 하나도 쓰지 않는다.
// 지도(OpenStreetMap)의 좌표만 받아서, 나머지는 전부 코드로 그린다.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { CFG } from './config.js';
import { makeSceneUniforms } from './util/glsl.js';
import { ChunkManager } from './core/chunkManager.js';
import { buildBuildingMesh } from './build/buildings.js';
import { buildRoadMesh } from './build/roads.js';
import { createBaseGround, buildAreaMesh } from './build/ground.js';
import { buildPropsMesh } from './build/props.js';
import { buildSignMesh, atlas } from './build/signs.js';
import { createSky } from './night/sky.js';
import { CameraRig } from './controls/rig.js';

const boot = document.getElementById('boot');
const bootBar = boot.querySelector('.bar i');
const bootMsg = document.getElementById('bootmsg');
const errBox = document.getElementById('err');

function fail(msg, e) {
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
  const index = await (await fetch('./data/index.json')).json();
  bootBar.style.width = '15%';

  // ── 렌더러 ──
  const renderer = new THREE.WebGLRenderer({
    antialias: true, powerPreference: 'high-performance',
    preserveDrawingBuffer: Q.has('shot'),
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CFG.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;   // 후처리 패스까지 합쳐서 세려면 수동 리셋
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.35, 6000);
  camera.position.set(-150, 190, 260);

  // ── 모든 재질이 공유하는 값 ──
  const U = makeSceneUniforms(THREE, CFG);
  U.uFloorH = { value: CFG.floorH };
  U.uGroundFloorH = { value: CFG.groundFloorH };

  scene.add(createSky(U));
  scene.add(createBaseGround(U));

  // ── 청크 빌더 등록 ──
  const builders = [
    { key: 'area', group: 'area', fn: (c, u) => buildAreaMesh(c, u) },
    { key: 'road', group: 'road', fn: (c, u) => buildRoadMesh(c, u) },
    { key: 'bld', group: 'osm', fn: (c, u) => buildBuildingMesh((c.buildings || []).filter(b => !b.gen), u) },
    { key: 'bldgen', group: 'gen', fn: (c, u) => buildBuildingMesh((c.buildings || []).filter(b => b.gen), u) },
    { key: 'prop', group: 'prop', fn: (c, u) => buildPropsMesh(c, u) },
    { key: 'sign', group: 'sign', fn: (c, u) => buildSignMesh(c, u) },
  ];
  const chunks = new ChunkManager(scene, U, index, builders);
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
  document.getElementById('m-walk').onclick = () => rig.setMode('walk');
  document.getElementById('m-fly').onclick = () => rig.setMode('fly');

  // ── URL 로 시점 지정(자동 검증용) ──
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
  if (Q.has('r')) CFG.viewRadius = Number(Q.get('r'));

  // ── HUD ──
  const el = id => document.getElementById(id);
  const bind = (id, fn) => { const e = el(id); if (e) e.onchange = () => fn(e); };
  bind('t-gen', e => { chunks.groups.gen.visible = e.checked; });
  bind('t-sign', e => { if (chunks.groups.sign) chunks.groups.sign.visible = e.checked; });
  bind('t-people', e => { if (chunks.groups.people) chunks.groups.people.visible = e.checked; });
  bind('t-car', e => { if (chunks.groups.car) chunks.groups.car.visible = e.checked; });
  bind('t-bloom', e => { bloom.enabled = e.checked; });
  const vd = el('vd'); vd.oninput = () => {
    CFG.viewRadius = Number(vd.value); el('vd-v').textContent = vd.value + ' m';
  };
  const lit = el('lit'); lit.oninput = () => {
    U.uLitRatio.value = Number(lit.value) / 100; el('lit-v').textContent = lit.value + '%';
  };

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

  // ── 루프 ──
  const clock = new THREE.Clock();
  let acc = 0, frames = 0, fps = 0;
  const mPerDegLat = index.mPerDegLat, mPerDegLon = index.mPerDegLon;
  const o = index.origin;

  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, clock.getDelta());
    U.uTime.value += dt;

    rig.update(dt);
    const focus = chunks.focusOf(camera);
    chunks.update(focus, CFG.viewRadius);

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
      el('nc').textContent = `${chunks.stats.built} / ${chunks.available.size}`;
      el('dc').textContent = renderer.info.render.calls;
      el('npc').textContent = `${(window.__people || 0).toLocaleString()} · ${(window.__cars || 0).toLocaleString()}`;
    }
    window.__fps = fps;
    window.__ready = chunks.isSettled(focus, CFG.viewRadius);
  }
  tick();

  window.__stats = () => ({
    fps: Math.round(window.__fps || 0),
    calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    chunks: chunks.stats.built,
    buildings: chunks.stats.buildings,
    signs: chunks.stats.signs,
    people: window.__people || 0,
    cars: window.__cars || 0,
  });
}

main().catch(e => fail('시작하지 못했습니다', e));
