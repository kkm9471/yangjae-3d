// 미니맵. 위에서 내려다본 도로망과 건물, 그리고 내가 선 자리와 보는 방향.
//
// 3D 화면만 보면 "여기가 어디지"가 계속 생긴다. 실제 지도 앱처럼
// 북쪽을 항상 위로 두고(N 표시) 내 시야를 부채꼴로 그린다.
// 이미지 파일은 여기서도 쓰지 않는다 — 캔버스에 직접 그린다.

import * as THREE from 'three';

const COL = {
  bg: '#080b12',
  bld: '#1b2334',
  bldGen: '#141a27',
  road: '#31415c',
  edge: '#2a3850',
};

export class Minimap {
  constructor(canvas, chunks) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.chunks = chunks;
    this.range = 180;          // 반경 몇 m를 보여줄지
    this.acc = 0;
    this.showGen = true;
    this._dir = new THREE.Vector3();
  }

  setRange(r) { this.range = Math.max(60, Math.min(600, r)); }

  update(dt, camera) {
    this.acc += dt;
    if (this.acc < 0.05) return;      // 20fps 로만 다시 그린다
    this.acc = 0;
    this.draw(camera);
  }

  draw(camera) {
    const c = this.ctx;
    const W = this.cv.width, H = this.cv.height;
    const px = camera.position.x, pz = camera.position.z;
    const s = (Math.min(W, H) / 2) / this.range;   // m → px

    c.fillStyle = COL.bg;
    c.fillRect(0, 0, W, H);

    // 원형으로 잘라내기
    c.save();
    c.beginPath();
    c.arc(W / 2, H / 2, Math.min(W, H) / 2 - 1, 0, Math.PI * 2);
    c.clip();

    const X = (x) => W / 2 + (x - px) * s;
    const Y = (z) => H / 2 + (z - pz) * s;

    // ── 건물 ──
    for (const [, r] of this.chunks.chunks) {
      if (!r.data || r.state !== 3) continue;
      if (Math.abs((r.cx + 0.5) * this.chunks.cs - px) > this.range + 120) continue;
      if (Math.abs((r.cz + 0.5) * this.chunks.cs - pz) > this.range + 120) continue;
      for (const b of (r.data.buildings || [])) {
        if (b.gen && !this.showGen) continue;
        const poly = b.poly;
        c.beginPath();
        c.moveTo(X(poly[0][0]), Y(poly[0][1]));
        for (let i = 1; i < poly.length; i++) c.lineTo(X(poly[i][0]), Y(poly[i][1]));
        c.closePath();
        c.fillStyle = b.gen ? COL.bldGen : COL.bld;
        c.fill();
      }
    }

    // ── 도로 (큰길일수록 굵고 밝게) ──
    for (const [, r] of this.chunks.chunks) {
      if (!r.data || r.state !== 3) continue;
      for (const road of (r.data.roads || [])) {
        if (road.tunnel) continue;
        const w = Math.max(1, road.w * s);
        c.lineWidth = w;
        c.strokeStyle = road.z >= 5 ? '#5a708f' : road.z >= 3 ? '#3d4d68' : '#2b374b';
        c.lineCap = 'round'; c.lineJoin = 'round';
        c.beginPath();
        c.moveTo(X(road.pts[0][0]), Y(road.pts[0][1]));
        for (let i = 1; i < road.pts.length; i++) c.lineTo(X(road.pts[i][0]), Y(road.pts[i][1]));
        c.stroke();
      }
    }

    // ── 시야 부채꼴 ──
    // 캔버스 X=월드 x, 캔버스 Y=월드 z 이므로 각도는 atan2(z, x) 그대로 쓴다.
    const d = camera.getWorldDirection(this._dir);
    const ang = Math.atan2(d.z, d.x);
    const half = (camera.fov * Math.PI / 180) * 0.62;
    c.beginPath();
    c.moveTo(W / 2, H / 2);
    c.arc(W / 2, H / 2, this.range * s * 0.85, ang - half, ang + half);
    c.closePath();
    c.fillStyle = 'rgba(140,200,255,0.13)';
    c.fill();

    c.restore();

    // ── 테두리 + 북쪽 표시 ──
    c.beginPath();
    c.arc(W / 2, H / 2, Math.min(W, H) / 2 - 1, 0, Math.PI * 2);
    c.strokeStyle = COL.edge; c.lineWidth = 2; c.stroke();

    c.fillStyle = '#8fd3ff';
    c.font = 'bold 11px system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.fillText('N', W / 2, 3);

    // ── 나 ──
    c.beginPath();
    c.arc(W / 2, H / 2, 3.5, 0, Math.PI * 2);
    c.fillStyle = '#ffd479';
    c.fill();
    c.strokeStyle = '#3a2c10'; c.lineWidth = 1; c.stroke();

    // 축척
    c.fillStyle = 'rgba(190,205,225,0.55)';
    c.font = '9px system-ui, sans-serif';
    c.textAlign = 'right'; c.textBaseline = 'bottom';
    c.fillText(`${this.range} m`, W - 5, H - 3);
  }
}
