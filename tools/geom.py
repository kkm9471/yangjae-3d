# -*- coding: utf-8 -*-
"""2D 기하 유틸. 외부 라이브러리 없이 표준 라이브러리만 쓴다."""
import math


def signed_area(ring):
    """(x,z) 링의 부호 있는 면적. 양수 = 반시계(수학 좌표 기준)."""
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        s += x1 * z2 - x2 * z1
    return s * 0.5


def area(ring):
    return abs(signed_area(ring))


def dedupe_ring(ring, eps=0.05):
    """끝점 중복 제거 + 너무 가까운 연속점 제거."""
    out = []
    for p in ring:
        if out and math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) < eps:
            continue
        out.append(p)
    while len(out) >= 2 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < eps:
        out.pop()
    return out


def simplify(pts, tol=0.3, closed=False):
    """Douglas-Peucker. 정점 수를 줄여 GPU 부담을 낮춘다."""
    if len(pts) < 3:
        return pts[:]
    if closed:
        # 닫힌 링은 시작점을 고정하고 두 구간으로 나눠 처리
        n = len(pts)
        far = max(range(1, n), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
        a = _dp(pts[0:far + 1], tol)
        b = _dp(pts[far:] + [pts[0]], tol)
        return a[:-1] + b[:-1]
    return _dp(pts, tol)


def _dp(pts, tol):
    if len(pts) < 3:
        return pts[:]
    x1, y1 = pts[0]
    x2, y2 = pts[-1]
    dx, dy = x2 - x1, y2 - y1
    dd = dx * dx + dy * dy
    imax, dmax = 0, -1.0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        if dd <= 1e-12:
            d = math.hypot(px - x1, py - y1)
        else:
            t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / dd))
            d = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
        if d > dmax:
            imax, dmax = i, d
    if dmax > tol:
        return _dp(pts[:imax + 1], tol)[:-1] + _dp(pts[imax:], tol)
    return [pts[0], pts[-1]]


def centroid(ring):
    a = signed_area(ring)
    if abs(a) < 1e-9:
        n = len(ring)
        return (sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n)
    cx = cz = 0.0
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        cr = x1 * z2 - x2 * z1
        cx += (x1 + x2) * cr
        cz += (z1 + z2) * cr
    return (cx / (6 * a), cz / (6 * a))


def bbox(pts):
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    return (min(xs), min(zs), max(xs), max(zs))


def point_in_ring(p, ring):
    x, z = p
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, zi = ring[i]
        xj, zj = ring[j]
        if (zi > z) != (zj > z):
            xint = (xj - xi) * (z - zi) / (zj - zi + 1e-18) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside


def seg_intersect(p1, p2, p3, p4):
    x1, y1 = p1; x2, y2 = p2; x3, y3 = p3; x4, y4 = p4
    d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
    if abs(d) < 1e-12:
        return False
    t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
    u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
    return 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0


def rings_overlap(a, b):
    """두 다각형이 겹치는가(경계 교차 또는 포함)."""
    ax0, az0, ax1, az1 = bbox(a)
    bx0, bz0, bx1, bz1 = bbox(b)
    if ax1 < bx0 or bx1 < ax0 or az1 < bz0 or bz1 < az0:
        return False
    na, nb = len(a), len(b)
    for i in range(na):
        for j in range(nb):
            if seg_intersect(a[i], a[(i + 1) % na], b[j], b[(j + 1) % nb]):
                return True
    return point_in_ring(a[0], b) or point_in_ring(b[0], a)


def dist_point_seg(p, a, b):
    px, pz = p; ax, az = a; bx, bz = b
    dx, dz = bx - ax, bz - az
    dd = dx * dx + dz * dz
    if dd <= 1e-12:
        return math.hypot(px - ax, pz - az), (ax, az), 0.0
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / dd))
    qx, qz = ax + t * dx, az + t * dz
    return math.hypot(px - qx, pz - qz), (qx, qz), t


def polyline_length(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))


def offset_polyline(pts, d):
    """폴리라인을 법선 방향으로 d만큼 평행이동(단순 버전).
    보도·가로수 배치용이라 뾰족한 코너의 정밀도는 요구하지 않는다."""
    out = []
    n = len(pts)
    for i in range(n):
        if i == 0:
            dx, dz = pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]
        elif i == n - 1:
            dx, dz = pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1]
        else:
            dx, dz = pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]
        L = math.hypot(dx, dz) or 1.0
        nx, nz = -dz / L, dx / L
        out.append((pts[i][0] + nx * d, pts[i][1] + nz * d))
    return out
