# -*- coding: utf-8 -*-
"""지형(표고) 데이터를 받아 그 지역의 높이판(heightfield)을 만든다.

지금까지 이 지도는 완전히 평평했다. 양재처럼 평지에서는 티가 안 나지만,
제주도를 평평하게 만들면 한라산 1,947m 가 바닥이 되고 그건 제주도가 아니다.

받는 곳: AWS 공개 데이터에 올라와 있는 terrarium 타일.
   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
   키도 가입도 필요 없다. 화소의 RGB 에 높이가 담겨 있다:
       높이(m) = R*256 + G + B/256 - 32768
   (SRTM·ASTER 등을 합쳐 만든 것. 30m 급이라 뾰족한 봉우리는 조금 뭉툭해진다)

이미지 파일을 쓰지 않는다는 이 프로젝트의 원칙은 '화면에 쓰는 그림'에 대한 것이다.
여기서 받는 PNG 는 만들 때만 쓰고 버리며, 결과물은 숫자 배열이다.

Pillow 같은 것을 깔지 않으려고 PNG 를 직접 푼다(zlib 은 표준 라이브러리).

사용법:
    python tools/dem.py --place yangjae
    python tools/dem.py --lat 33.36 --lon 126.53 --half-x 40000 --half-z 20000 --name jeju
"""
import argparse
import json
import math
import os
import struct
import sys
import time
import urllib.request
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import config as CF          # noqa: E402

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
UA = {"User-Agent": "yangjae-3d/1.0 (하나의 개인 프로젝트)"}
OUT_DIR = os.path.join(ROOT, "web", "data", "dem")
CACHE_DIR = os.path.join(ROOT, "data", "dem_tiles")

# 바다는 정확히 0 이 아니라 살짝 아래로 둔다. 그래야 해안선에서 물이 땅을 덮는다.
SEA_LEVEL = 0.0


# ───────────────────────── 타일 좌표 ─────────────────────────
def deg2tile(lat, lon, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    la = math.radians(max(-85.0, min(85.0, lat)))
    y = (1.0 - math.log(math.tan(la) + 1.0 / math.cos(la)) / math.pi) / 2.0 * n
    return x, y


def tile_span_m(z, lat):
    """그 위도에서 타일 한 장이 덮는 가로 거리(m)"""
    return 2 * math.pi * 6378137.0 * math.cos(math.radians(lat)) / (2 ** z)


# ───────────────────────── PNG 풀기 ─────────────────────────
def png_rgb(data):
    """8비트 PNG → (폭, 높이, 픽셀바이트, 채널수)"""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG 가 아닙니다")
    pos, idat, w, h, ch = 8, [], 0, 0, 3
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, color = struct.unpack(">IIBB", body[:10])
            if depth != 8:
                raise ValueError(f"8비트가 아닙니다({depth})")
            ch = {0: 1, 2: 3, 4: 2, 6: 4}[color]
        elif typ == b"IDAT":
            idat.append(body)
        elif typ == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(b"".join(idat))
    stride = w * ch
    out = bytearray(w * h * ch)
    prev = bytearray(stride)
    p = 0
    for row in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[row * stride:(row + 1) * stride] = line
        prev = line
    return w, h, bytes(out), ch


# ───────────────────────── 타일 받기 ─────────────────────────
_MEM = {}


def fetch_tile(z, x, y, say=print):
    """한 장 받아서 (폭, 픽셀, 채널) 로. 받은 것은 디스크에 쌓아 두고 다시 안 받는다."""
    key = (z, x, y)
    if key in _MEM:
        return _MEM[key]
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{z}_{x}_{y}.png")
    raw = None
    if os.path.exists(path):
        with open(path, "rb") as f:
            raw = f.read()
    else:
        url = TILE_URL.format(z=z, x=x, y=y)
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=45) as r:
                    raw = r.read()
                break
            except Exception as e:
                if attempt == 3:
                    say(f"    타일 {z}/{x}/{y} 실패: {str(e)[:60]}")
                    return None
                time.sleep(1.5 * (attempt + 1))
        if raw:
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(raw)
            os.replace(tmp, path)
    if not raw:
        return None
    try:
        w, h, px, ch = png_rgb(raw)
    except Exception as e:
        say(f"    타일 {z}/{x}/{y} 해독 실패: {e}")
        return None
    rec = (w, px, ch)
    # 너무 많이 쌓으면 메모리를 먹는다. 제주 z=12 는 100장 남짓이라 넉넉하다.
    if len(_MEM) < 400:
        _MEM[key] = rec
    return rec


def elev_at(lat, lon, z, say=print):
    """그 지점의 표고(m). 못 받으면 None."""
    fx, fy = deg2tile(lat, lon, z)
    tx, ty = int(math.floor(fx)), int(math.floor(fy))
    t = fetch_tile(z, tx, ty, say)
    if t is None:
        return None
    w, px, ch = t
    ix = min(w - 1, max(0, int((fx - tx) * w)))
    iy = min(w - 1, max(0, int((fy - ty) * w)))
    i = (iy * w + ix) * ch
    return (px[i] * 256 + px[i + 1] + px[i + 2] / 256.0) - 32768.0


# ───────────────────────── 높이판 만들기 ─────────────────────────
def build(lat, lon, half_x, half_z, step, z, slug, name, say=print):
    """중심(lat,lon) 에서 동서 ±half_x m, 남북 ±half_z m 를 step m 간격으로 잰다."""
    CF.set_origin(lat, lon)
    nx = int(half_x * 2 / step) + 1
    nz = int(half_z * 2 / step) + 1
    total = nx * nz
    say(f"[{name}] {half_x*2/1000:.0f}km x {half_z*2/1000:.0f}km 를 {step:.0f}m 간격으로 잽니다")
    say(f"   격자 {nx} x {nz} = {total:,}점 · 지형타일 z={z}"
        f" (한 화소 약 {tile_span_m(z, lat)/256:.0f}m)")

    # 필요한 타일을 미리 세어 본다 — 몇 장인지 모르고 시작하면 안 된다
    tiles = set()
    for j in (0, nz - 1):
        for i in (0, nx - 1):
            la, lo = CF.to_latlon(-half_x + i * step, -half_z + j * step)
            fx, fy = deg2tile(la, lo, z)
            tiles.add((int(fx), int(fy)))
    xs = [t[0] for t in tiles]; ys = [t[1] for t in tiles]
    ntile = (max(xs) - min(xs) + 1) * (max(ys) - min(ys) + 1)
    say(f"   받아야 할 지형타일 약 {ntile}장 (한 장 42KB · 이미 받은 건 다시 안 받음)")

    heights = bytearray(total * 2)
    lo_v, hi_v, miss = 1e9, -1e9, 0
    t0 = time.time()
    for j in range(nz):
        zz = -half_z + j * step
        for i in range(nx):
            xx = -half_x + i * step
            la, lo = CF.to_latlon(xx, zz)
            e = elev_at(la, lo, z, say)
            if e is None:
                e = SEA_LEVEL
                miss += 1
            lo_v = min(lo_v, e); hi_v = max(hi_v, e)
            # 데시미터(0.1m) 단위 int16. -3276.8m ~ 3276.7m 까지 담긴다.
            v = int(round(max(-3276.0, min(3276.0, e)) * 10))
            struct.pack_into("<h", heights, (j * nx + i) * 2, v)
        if (j + 1) % max(1, nz // 12) == 0:
            say(f"   {j+1}/{nz} 줄 ({(j+1)*100//nz}%) · {time.time()-t0:.0f}초")

    os.makedirs(OUT_DIR, exist_ok=True)
    bin_path = os.path.join(OUT_DIR, f"{slug}.bin")
    tmp = bin_path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(heights)
    os.replace(tmp, bin_path)

    meta = {
        "slug": slug, "name": name,
        "lat": lat, "lon": lon,
        "halfX": half_x, "halfZ": half_z,
        "step": step, "nx": nx, "nz": nz,
        "unit": 0.1,                  # 저장값 x 0.1 = 미터
        "min": round(lo_v, 1), "max": round(hi_v, 1),
        "seaLevel": SEA_LEVEL,
        "source": "AWS terrarium (SRTM/ASTER 등)", "zoom": z,
        "madeAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    meta_path = os.path.join(OUT_DIR, f"{slug}.json")
    tmp = meta_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(tmp, meta_path)

    say(f"[저장] {bin_path}  ({len(heights)/1024/1024:.1f}MB)")
    say(f"       높이 {lo_v:.0f}m ~ {hi_v:.0f}m" + (f" · 못 받은 점 {miss:,}개" if miss else ""))
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--place", default=None, help="만들어 둔 동네 이름")
    ap.add_argument("--lat", type=float, default=None)
    ap.add_argument("--lon", type=float, default=None)
    ap.add_argument("--name", default=None)
    ap.add_argument("--slug", default=None)
    ap.add_argument("--half-x", type=float, default=None, help="동서 반폭(m)")
    ap.add_argument("--half-z", type=float, default=None, help="남북 반폭(m)")
    ap.add_argument("--step", type=float, default=None, help="격자 간격(m)")
    ap.add_argument("--zoom", type=int, default=None, help="지형타일 확대 단계")
    args = ap.parse_args()

    if args.place:
        with open(os.path.join(ROOT, "web", "data", "places.json"), encoding="utf-8") as f:
            pj = json.load(f)
        pl = next((p for p in pj["places"] if p["slug"] == args.place), None)
        if not pl:
            raise SystemExit(f"[중단] '{args.place}' 동네가 없습니다.")
        lat, lon = pl["lat"], pl["lon"]
        slug, name = pl["slug"], pl["name"]
        half = float(pl.get("radius") or 1000)
        half_x = args.half_x if args.half_x is not None else half
        half_z = args.half_z if args.half_z is not None else half
    else:
        if args.lat is None or args.lon is None:
            ap.error("--place 를 주거나 --lat/--lon 을 주세요.")
        lat, lon = args.lat, args.lon
        slug = args.slug or args.name or "region"
        name = args.name or slug
        half_x = args.half_x if args.half_x is not None else 1000
        half_z = args.half_z if args.half_z is not None else 1000

    # 간격과 확대단계는 넓이에 맞춰 저절로 고른다.
    # 좁은 동네는 촘촘히, 섬 하나는 성기게 — 안 그러면 파일이 수백 MB 가 된다.
    span = max(half_x, half_z) * 2
    step = args.step if args.step is not None else (
        8.0 if span <= 4000 else 15.0 if span <= 20000 else 30.0)
    zoom = args.zoom if args.zoom is not None else (
        14 if span <= 4000 else 13 if span <= 20000 else 12)

    build(lat, lon, half_x, half_z, step, zoom, slug, name)


if __name__ == "__main__":
    sys.exit(main())
