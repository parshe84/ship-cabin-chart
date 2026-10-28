#!/usr/bin/env python3
"""Builds the detailed depth layer: src/maps/depth/*.bin, isobaths from the GEBCO 2026 Grid
(15 arc-second, ~460 m; public domain, "GEBCO Compilation Group (2026) GEBCO 2026 Grid").

Only 5°x5° squares with water shallower than 200 m (shelves, coasts, banks) are built: the open ocean
is covered well by the general layer (bathymetry.json). Each square holds "deeper than N metres"
polygons for every chart depth, so world-chart.js can draw it on its own from zoom 8.

Input: the eight GEBCO GeoTIFF tiles (uncompressed int16) in .cache/gebco, from
https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2026/ice_surface_elevation/geotiff/gebco_2026_geotiff.zip

File format (little endian), read by world-chart.js:
  uint32 polygon count; per polygon: uint16 depth, uint32 ring count; per ring: uint32 point count, then the
  points as zigzag varints of the deltas of round(lon * 1e5), round(lat * 1e5) from the previous point
  (the first point of every polygon is relative to the square's south-west corner).

Usage: pip install numpy tifffile contourpy shapely && python3 scripts/build-gebco.py
"""

import glob
import json
import math
import os
import re
import struct
import time
from multiprocessing import Pool

import contourpy
import numpy as np
import shapely
import tifffile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, '.cache', 'gebco')
OUT = os.path.join(ROOT, 'src', 'maps', 'depth')
SQUARE = 5
CELLS = 240  # per degree
PAD = 4
# Must match world-chart.js DEPTH_LEVELS (without 0).
DEPTHS = [5, 10, 20, 30, 50, 100, 200, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]

_tiles = None


def tiles():
    global _tiles
    if _tiles is None:
        _tiles = []
        for path in glob.glob(os.path.join(SRC, 'gebco_2026_n*_geotiff.tif')):
            n, s, w, e = map(float, re.search(r'_n(-?[\d.]+)_s(-?[\d.]+)_w(-?[\d.]+)_e(-?[\d.]+)_', path).groups())
            _tiles.append((n, s, w, e, tifffile.memmap(path)))
    return _tiles


def block(w, s, e, n):
    """Elevation grid (rows north to south) for a box in whole cells; outside the world = edge values."""
    cols = round((e - w) * CELLS)
    rows = round((n - s) * CELLS)
    out = np.full((rows, cols), np.nan, dtype=np.float32)
    for tn, ts, tw, te, data in tiles():
        x0, x1 = max(w, tw), min(e, te)
        y0, y1 = max(s, ts), min(n, tn)
        if x0 >= x1 or y0 >= y1:
            continue
        r0, r1 = round((tn - y1) * CELLS), round((tn - y0) * CELLS)
        c0, c1 = round((x0 - tw) * CELLS), round((x1 - tw) * CELLS)
        orr, occ = round((n - y1) * CELLS), round((x0 - w) * CELLS)
        out[orr:orr + r1 - r0, occ:occ + c1 - c0] = data[r0:r1, c0:c1]
    if np.isnan(out).any():
        # Beyond ±180° or the poles: repeat the edge values.
        mask = np.isnan(out)
        out[mask] = np.nanmean(out) if not mask.all() else 0
    return out


def smooth(g):
    p = np.pad(g, 1, mode='edge')
    h, w = g.shape
    return sum(p[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)) / 9


def polygons(g):
    if g.geom_type == 'Polygon':
        yield g
    elif hasattr(g, 'geoms'):
        for p in g.geoms:
            yield from polygons(p)


def varint(v, buf):
    v = (v << 1) ^ (v >> 63)
    while True:
        b = v & 0x7f
        v >>= 7
        if v:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            return


def build(square):
    sx, sy = square
    w, s, e, n = sx - PAD / CELLS, sy - PAD / CELLS, sx + SQUARE + PAD / CELLS, sy + SQUARE + PAD / CELLS
    z = block(w, s, e, n)
    shelf = np.count_nonzero((z < 0) & (z > -200))
    if shelf < 20:
        return None
    clip = shapely.box(sx, sy, sx + SQUARE, sy + SQUARE)
    fine = smooth(z)
    coarse = smooth(z[::4, ::4]) if min(z.shape) > 16 else fine
    out = []
    for depth in DEPTHS:
        if np.nanmin(z) > -depth:
            break
        deep = depth >= 1000
        grid = coarse if deep else fine
        step = 4 if deep else 1
        gen = contourpy.contour_generator(z=grid, fill_type='OuterOffset', chunk_size=512)
        pts_list, offs_list = gen.filled(-1e6, -depth)
        geoms = []
        for pts, offs in zip(pts_list, offs_list):
            rings = [pts[offs[i]:offs[i + 1]] for i in range(len(offs) - 1)]
            rings = [r for r in rings if len(r) >= 4]
            if not rings:
                continue
            ll = [np.column_stack([w + (r[:, 0] * step + 0.5) / CELLS, n - (r[:, 1] * step + 0.5) / CELLS]) for r in rings]
            geoms.append(shapely.Polygon(ll[0], ll[1:]))
        if not geoms:
            continue
        tol = (1.6 if deep else 0.7) / CELLS
        min_area = (8 if deep else 2) / CELLS ** 2
        merged = shapely.make_valid(shapely.simplify(np.asarray(geoms), tol, preserve_topology=True))
        for g in merged:
            for p in polygons(shapely.intersection(g, clip)):
                if p.area >= min_area:
                    out.append((depth, p))
    if not out:
        return None
    buf = bytearray(struct.pack('<I', len(out)))
    points = 0
    for depth, p in out:
        rings = [p.exterior] + [r for r in p.interiors if shapely.Polygon(r).area >= 2 / CELLS ** 2]
        buf += struct.pack('<HI', depth, len(rings))
        px, py = round(sx * 1e5), round(sy * 1e5)
        for r in rings:
            c = np.round(np.asarray(r.coords)[:-1] * 1e5).astype(np.int64)
            buf += struct.pack('<I', len(c))
            points += len(c)
            for x, y in c:
                varint(int(x - px), buf)
                varint(int(y - py), buf)
                px, py = x, y
    name = f'D_{"E" if sx >= 0 else "W"}{abs(sx):03d}_{"N" if sy >= 0 else "S"}{abs(sy):02d}'
    with open(os.path.join(OUT, f'{name}.bin'), 'wb') as fh:
        fh.write(buf)
    return {'name': name, 'bbox': [sx, sy, sx + SQUARE, sy + SQUARE], 'polygons': len(out), 'points': points, 'bytes': len(buf)}


def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):
        os.remove(os.path.join(OUT, old))
    squares = [(x, y) for y in range(-90, 90, SQUARE) for x in range(-180, 180, SQUARE)]
    index = []
    with Pool(os.cpu_count()) as pool:
        for i, r in enumerate(pool.imap_unordered(build, squares, chunksize=4), 1):
            if r:
                index.append(r)
            if i % 100 == 0:
                print(f'  {i}/{len(squares)} squares, {len(index)} built, {sum(x["bytes"] for x in index) / 1e6:.1f} MB ({time.time() - t0:.0f}s)', flush=True)
    index.sort(key=lambda r: r['name'])
    with open(os.path.join(OUT, 'index.json'), 'w') as fh:
        json.dump([{k: r[k] for k in ('name', 'bbox')} for r in index], fh, separators=(',', ':'))
    print(f'{len(index)} squares, {sum(r["points"] for r in index)} points, {sum(r["bytes"] for r in index) / 1e6:.1f} MB ({time.time() - t0:.0f}s)')


if __name__ == '__main__':
    main()
