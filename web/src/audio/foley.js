// 소리도 파일을 쓰지 않는다.
//
// 발소리·도시 소음을 mp3 로 넣으면 "이미지·폰트·소리 파일 0개"가 깨진다.
// 그래서 브라우저의 소리 합성기(Web Audio)로 잡음을 만들어 필터에 통과시킨다.
//   발소리 = 아주 짧은 잡음 한 번 + 낮은 '툭' 소리
//   도시 소음 = 낮은 주파수만 남긴 잡음(멀리서 오는 차 소리처럼 들린다)
//
// 브라우저는 사용자가 화면을 클릭하기 전에는 소리를 못 내게 막는다.
// 걷기 모드가 어차피 클릭으로 시작하므로 그때 켠다.

export class Foley {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.noise = null;
    this.ambGain = null;
    this._ambSrc = null;
  }

  /** 사용자 클릭 안에서 불러야 한다 */
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();

    // 2초짜리 백색잡음 하나를 만들어 두고 계속 재사용한다
    const n = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;      // 살짝 저음쪽으로 기울인 잡음
      d[i] = w * 0.7 + last * 3;
    }

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(this.ctx.destination);
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.start();
    if (!this.ctx) return;
    this.ctx.resume();
    this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.15);
    if (on) this._ambienceOn(); else this._ambienceOff();
  }

  _ambienceOn() {
    if (!this.ctx || this._ambSrc) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.4;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 60;
    this.ambGain = this.ctx.createGain();
    this.ambGain.gain.value = 0.0;
    src.connect(lp); lp.connect(hp); hp.connect(this.ambGain); this.ambGain.connect(this.master);
    src.start();
    this._ambSrc = src;
  }

  _ambienceOff() {
    if (this._ambSrc) { try { this._ambSrc.stop(); } catch (e) {} this._ambSrc = null; }
  }

  /** 도시 소음 크기 (큰길에 가까울수록 크게). 0~1 */
  setAmbience(level) {
    if (!this.ctx || !this.ambGain) return;
    this.ambGain.gain.setTargetAtTime(0.055 * Math.max(0, Math.min(1, level)),
                                      this.ctx.currentTime, 0.4);
  }

  /** 발소리 한 번 */
  step(speed) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const loud = Math.min(1, 0.35 + speed / 9);

    // ① 신발이 바닥에 닿는 마찰음
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.4;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 900;
    bp.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.11 * loud, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.10);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.12);

    // ② 뒤꿈치가 닿는 낮은 '툭'
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120 + Math.random() * 30, t);
    osc.frequency.exponentialRampToValueAtTime(52, t + 0.07);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.05 * loud, t);
    g2.gain.exponentialRampToValueAtTime(0.0004, t + 0.09);
    osc.connect(g2); g2.connect(this.master);
    osc.start(t); osc.stop(t + 0.1);
  }
}
