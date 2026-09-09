// 터치 조작 (아이폰·안드로이드)
//
// 아이폰 사파리에는 Pointer Lock 이 없다. 데스크톱처럼 "마우스를 화면에 가두고
// 마우스 이동 = 시선" 방식을 쓸 수 없다는 뜻이다. 키보드도 없다.
// 그래서 화면을 좌우로 나눠 쓴다.
//
//   왼쪽 절반  : 손가락을 댄 자리에 조이스틱이 생긴다. 민 방향으로 걷고, 끝까지 밀면 달린다.
//   오른쪽 절반: 문지르면 고개가 돌아간다.
//
// 조이스틱을 화면 구석에 고정하지 않고 '누른 자리에 생기게' 한 이유:
// 손 크기와 쥐는 자세가 사람마다 달라서, 고정해 두면 엄지가 안 닿는 사람이 생긴다.
//
// 둘러보기(orbit) 모드에서는 아무것도 하지 않는다. OrbitControls 가 이미
// 한 손가락 회전·두 손가락 확대를 처리하고 있어서, 여기서 또 잡으면 서로 싸운다.

const RADIUS = 58;          // 조이스틱 반지름(px)
const DEAD = 0.12;          // 이 안쪽은 안 움직인 것으로 본다(손 떨림)
const RUN_AT = 0.86;        // 이만큼 밀면 달린다
const LOOK_SPEED = 0.0052;  // 1px 문지를 때 도는 각(rad)

export class TouchControls {
  /**
   * @param {object} rig  CameraRig — move/look 을 여기에 써 넣는다
   * @param {HTMLElement} dom  캔버스
   */
  constructor(rig, dom) {
    this.rig = rig;
    this.dom = dom;
    this.moveId = null;       // 걷기를 맡은 손가락
    this.lookId = null;       // 시선을 맡은 손가락
    this.origin = { x: 0, y: 0 };
    this.lastLook = { x: 0, y: 0 };
    this.active = false;      // 터치를 한 번이라도 썼는가(그때 UI를 보여 준다)

    this._buildUI();

    dom.addEventListener('pointerdown', e => this._down(e));
    dom.addEventListener('pointermove', e => this._move(e));
    dom.addEventListener('pointerup', e => this._up(e));
    dom.addEventListener('pointercancel', e => this._up(e));
    // iOS 는 화면 가장자리 제스처 등으로 pointercancel 을 자주 던진다.
    // 위에서 같이 받아 두지 않으면 손가락을 뗐는데도 계속 걷는다.
  }

  _buildUI() {
    const wrap = document.createElement('div');
    wrap.id = 'stick';
    wrap.style.cssText = `position:fixed;z-index:8;pointer-events:none;display:none;
      width:${RADIUS * 2}px;height:${RADIUS * 2}px;margin:${-RADIUS}px 0 0 ${-RADIUS}px;
      border-radius:50%;border:2px solid rgba(150,200,255,.34);
      background:rgba(10,18,32,.28);backdrop-filter:blur(2px)`;
    const knob = document.createElement('div');
    knob.style.cssText = `position:absolute;left:50%;top:50%;width:52px;height:52px;
      margin:-26px 0 0 -26px;border-radius:50%;
      background:rgba(143,211,255,.5);border:1px solid rgba(200,230,255,.75)`;
    wrap.appendChild(knob);
    document.body.appendChild(wrap);
    this.ui = wrap;
    this.knob = knob;
  }

  /** 이 모드에서 터치를 가로채야 하는가 */
  _wants() {
    return this.rig.mode !== 'orbit';
  }

  _down(e) {
    if (e.pointerType !== 'touch' || !this._wants()) return;
    this.active = true;
    if (e.clientX < innerWidth * 0.5) {
      if (this.moveId !== null) return;
      this.moveId = e.pointerId;
      this.origin.x = e.clientX; this.origin.y = e.clientY;
      this.ui.style.left = e.clientX + 'px';
      this.ui.style.top = e.clientY + 'px';
      this.ui.style.display = 'block';
      this.knob.style.transform = 'translate(0,0)';
      this.rig.auto = false;              // 직접 조작하면 자동 산책은 멈춘다
      this.rig._syncAutoBtn();
    } else {
      if (this.lookId !== null) return;
      this.lookId = e.pointerId;
      this.lastLook.x = e.clientX; this.lastLook.y = e.clientY;
    }
    this.dom.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  _move(e) {
    if (e.pointerType !== 'touch') return;
    if (e.pointerId === this.moveId) {
      let dx = e.clientX - this.origin.x;
      let dy = e.clientY - this.origin.y;
      const len = Math.hypot(dx, dy);
      if (len > RADIUS) { dx *= RADIUS / len; dy *= RADIUS / len; }
      this.knob.style.transform = `translate(${dx}px,${dy}px)`;
      const mag = Math.min(1, len / RADIUS);
      if (mag < DEAD) {
        this.rig.touchMove.set(0, 0);
      } else {
        // 화면 위로 밀면 앞으로. 화면 y 는 아래가 +라서 부호를 뒤집는다.
        const s = (mag - DEAD) / (1 - DEAD) / Math.max(1e-4, mag);
        this.rig.touchMove.set(dx / RADIUS * s, -dy / RADIUS * s);
      }
      this.rig.touchRun = mag > RUN_AT;
      e.preventDefault();
    } else if (e.pointerId === this.lookId) {
      this.rig.yaw -= (e.clientX - this.lastLook.x) * LOOK_SPEED;
      this.rig.pitch -= (e.clientY - this.lastLook.y) * LOOK_SPEED;
      this.rig.pitch = Math.max(-1.45, Math.min(1.45, this.rig.pitch));
      this.lastLook.x = e.clientX; this.lastLook.y = e.clientY;
      this.rig.auto = false;
      this.rig._syncAutoBtn();
      e.preventDefault();
    }
  }

  _up(e) {
    if (e.pointerId === this.moveId) {
      this.moveId = null;
      this.ui.style.display = 'none';
      this.rig.touchMove.set(0, 0);
      this.rig.touchRun = false;
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
  }

  /** 모드가 바뀌었을 때 손가락 상태를 지운다(조이스틱이 남아 걷는 사고 방지) */
  reset() {
    this.moveId = this.lookId = null;
    this.ui.style.display = 'none';
    this.rig.touchMove.set(0, 0);
    this.rig.touchRun = false;
  }
}

/** 터치로 조작하는 기기인가 (마우스가 없는 기기) */
export function isTouchDevice() {
  return matchMedia('(hover: none) and (pointer: coarse)').matches;
}
