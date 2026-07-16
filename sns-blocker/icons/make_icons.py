#!/usr/bin/env python3
"""猫フェイスのアイコンPNG(16/48/128px)を純Pythonで生成する。
外部ライブラリ不要。4xスーパーサンプリングで簡易アンチエイリアス。"""
import struct
import zlib
import math
import os

SS = 4  # supersampling factor


def mix(c1, c2, t):
    return tuple(c1[i] + (c2[i] - c1[i]) * t for i in range(len(c1)))


def over(dst, src):
    # src, dst = (r,g,b,a) 0..1  -> alpha compositing src over dst
    sa = src[3]
    da = dst[3]
    oa = sa + da * (1 - sa)
    if oa == 0:
        return (0, 0, 0, 0)
    r = (src[0] * sa + dst[0] * da * (1 - sa)) / oa
    g = (src[1] * sa + dst[1] * da * (1 - sa)) / oa
    b = (src[2] * sa + dst[2] * da * (1 - sa)) / oa
    return (r, g, b, oa)


def in_rounded_rect(x, y, half, rr):
    dx = abs(x - 0.5)
    dy = abs(y - 0.5)
    inner = half - rr
    if dx <= inner or dy <= inner:
        return dx <= half and dy <= half
    cx = 0.5 + (inner if x > 0.5 else -inner)
    cy = 0.5 + (inner if y > 0.5 else -inner)
    return math.hypot(x - cx, y - cy) <= rr


def in_circle(x, y, cx, cy, r):
    return math.hypot(x - cx, y - cy) <= r


def in_tri(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


# パステルカラー
BG1 = (1.0, 0.56, 0.66)   # #ff8fa8
BG2 = (1.0, 0.44, 0.57)   # #ff6f91
WHITE = (1.0, 0.98, 0.99)
EAR_IN = (1.0, 0.72, 0.79)  # #ffb7c5
EYE = (0.23, 0.23, 0.25)
NOSE = (1.0, 0.56, 0.66)


def sample(x, y):
    """正規化座標(0..1)の色 (r,g,b,a) を返す。"""
    px = (0, 0, 0, 0)

    # 背景：角丸ピンク（斜めグラデーション）
    if in_rounded_rect(x, y, 0.5, 0.24):
        t = (x + y) / 2.0
        px = over(px, (*mix(BG1, BG2, t), 1.0))

    # 耳（三角）
    left_ear = [(0.24, 0.42), (0.20, 0.14), (0.46, 0.30)]
    right_ear = [(0.76, 0.42), (0.80, 0.14), (0.54, 0.30)]
    if in_tri(x, y, *left_ear) or in_tri(x, y, *right_ear):
        px = over(px, (*WHITE, 1.0))
    left_ear_in = [(0.26, 0.40), (0.24, 0.20), (0.42, 0.31)]
    right_ear_in = [(0.74, 0.40), (0.76, 0.20), (0.58, 0.31)]
    if in_tri(x, y, *left_ear_in) or in_tri(x, y, *right_ear_in):
        px = over(px, (*EAR_IN, 1.0))

    # 顔（白い円）
    if in_circle(x, y, 0.5, 0.58, 0.30):
        px = over(px, (*WHITE, 1.0))

    # ほっぺ（薄いピンク）
    if in_circle(x, y, 0.34, 0.64, 0.055) or in_circle(x, y, 0.66, 0.64, 0.055):
        px = over(px, (*EAR_IN, 0.6))

    # 目
    if in_circle(x, y, 0.40, 0.56, 0.045) or in_circle(x, y, 0.60, 0.56, 0.045):
        px = over(px, (*EYE, 1.0))

    # 鼻（小さな逆三角）
    nose = [(0.47, 0.63), (0.53, 0.63), (0.50, 0.67)]
    if in_tri(x, y, *nose):
        px = over(px, (*NOSE, 1.0))

    return px


def render(size):
    big = size * SS
    rows = []
    for j in range(size):
        row = bytearray()
        for i in range(size):
            r = g = b = a = 0.0
            for sj in range(SS):
                for si in range(SS):
                    x = (i * SS + si + 0.5) / big
                    y = (j * SS + sj + 0.5) / big
                    pr, pg, pb, pa = sample(x, y)
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n = SS * SS
            a_avg = a / n
            if a_avg > 0:
                r = r / a
                g = g / a
                b = b / a
            row += bytes((
                int(round(r * 255)),
                int(round(g * 255)),
                int(round(b * 255)),
                int(round(a_avg * 255)),
            ))
        rows.append(row)
    return rows


def write_png(path, size):
    rows = render(size)
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0
        raw += row

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, size, "px")


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    for s in (16, 48, 128):
        write_png(os.path.join(here, "icon%d.png" % s), s)
