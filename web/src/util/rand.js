// 결정적 난수. 같은 seed → 항상 같은 결과.
// (새로고침할 때마다 간판·창문이 바뀌면 "아까 그 건물"을 확인할 수 없다)

export function h32(...vals) {
  let x = 0x811c9dc5 >>> 0;
  for (let v of vals) {
    v = (v | 0) >>> 0;
    x = (x ^ v) >>> 0;
    x = Math.imul(x, 16777619) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0;
  }
  return x >>> 0;
}

export function rnd(...vals) {
  return h32(...vals) / 4294967296;
}

export function rndRange(lo, hi, ...vals) {
  return lo + (hi - lo) * rnd(...vals);
}

export function pick(arr, ...vals) {
  return arr[h32(...vals) % arr.length];
}

/** 정수 seed 하나로 이어지는 난수열(순차 호출용) */
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
