#!/usr/bin/env python3
"""Builds the bundled world depth chart (isobaths) for the offline map.

Source: Terrarium elevation tiles (Mapzen / AWS Open Data, s3://elevation-tiles-prod).
Ocean depths there come from ETOPO1 (NOAA, 1 arc-minute global relief, public domain)
and finer national surveys where available.

Steps: download zoom-6 tiles (4096 PNGs, ~250 MB, cached in .cache/terrarium), stitch a
16384 x 16384 Web Mercator depth grid, trace "deeper than N metres" polygons at standard
chart depths, simplify and write src/maps/world/bathymetry.json.

Usage: pip install numpy pillow contourpy shapely && python3 scripts/build-bathymetry.py
"""

import io
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import contourpy
import numpy as np
from PIL import Image
from shapely.geometry import Polygon, mapping
from shapely.validation import make_valid

ZOOM = 6
TILE = 256
N = TILE * 2 ** ZOOM  # grid size in pixels
URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

# Standard chart depth contours (metres).
DEPTHS = [10, 20, 50, 100, 200, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache', 'terrarium', str(ZOOM))
OUT = os.path.join(ROOT, 'src', 'maps', 'world', 'bathymetry.json')


def fetch(xy):
    x, y = xy
    path = os.path.join(CACHE, str(x), f'{y}.png')
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(URL.format(z=ZOOM, x=x, y=y), timeout=60) as r:
                    data = r.read()
                break
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        with open(path + '.part', 'wb') as f:
            f.write(data)
        os.replace(path + '.part', path)
    return x, y, path


def load_grid():
    tiles = [(x, y) for x in range(2 ** ZOOM) for y in range(2 ** ZOOM)]
    grid = np.empty((N, N), dtype=np.float32)
    done = 0
    with ThreadPoolExecutor(max_workers=16) as pool:
        for x, y, path in pool.map(fetch, tiles):
            rgb = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)
            # Terrarium encoding: (R * 256 + G + B / 256) - 32768 metres
            elev = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
            grid[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE] = elev
            done += 1
            if done % 256 == 0:
                print(f'  tiles {done}/{len(tiles)}', flush=True)
    return grid


def smooth(grid):
    # Light 3x3 box blur: removes single-pixel noise so isobaths come out clean.
    p = np.pad(grid, 1, mode='edge')
    out = np.zeros_like(grid)
    for dy in range(3):
        for dx in range(3):
            out += p[dy:dy + N, dx:dx + N]
    return out / 9


def to_lonlat(points):
    x = (points[:, 0] + 0.5) / N
    y = (points[:, 1] + 0.5) / N
    lon = x * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * y))))
    return np.round(np.column_stack([lon, lat]), 3)


def polygons_deeper_than(gen, depth, min_area_px, tolerance_px):
    # Region where elevation < -depth: filled contour between -inf and -depth.
    points_list, offsets_list = gen.filled(-1e6, -depth)
    features = []
    for points, offsets in zip(points_list, offsets_list):
        rings = [points[offsets[i]:offsets[i + 1]] for i in range(len(offsets) - 1)]
        rings = [r for r in rings if len(r) >= 4]
        if not rings:
            continue
        poly = Polygon(rings[0], rings[1:])
        if poly.area < min_area_px:
            continue
        poly = poly.simplify(tolerance_px, preserve_topology=True)
        if poly.is_empty:
            continue
        if not poly.is_valid:
            poly = make_valid(poly)
        geoms = getattr(poly, 'geoms', [poly])
        for g in geoms:
            if g.geom_type != 'Polygon' or g.area < min_area_px:
                continue
            ext = to_lonlat(np.asarray(g.exterior.coords))
            holes = [to_lonlat(np.asarray(h.coords)) for h in g.interiors if Polygon(h).area >= min_area_px]
            features.append({
                'type': 'Feature',
                'properties': {'depth': depth},
                'geometry': {'type': 'Polygon', 'coordinates': [ext.tolist()] + [h.tolist() for h in holes]},
            })
    return features


def main():
    t0 = time.time()
    print(f'Downloading/reading {4 ** ZOOM} tiles…', flush=True)
    grid = load_grid()
    print(f'Grid {N}x{N}, min {grid.min():.0f} m, max {grid.max():.0f} m ({time.time() - t0:.0f}s)', flush=True)
    grid = smooth(grid)
    gen = contourpy.contour_generator(z=grid, fill_type='OuterOffset', chunk_size=1024)

    features = []
    for depth in DEPTHS:
        # Shallow contours matter near coasts: keep small shapes. In the deep ocean, drop the
        # speckle of tiny abyssal-hill blobs that only adds noise and size.
        if depth <= 2000:
            layer = polygons_deeper_than(gen, depth, min_area_px=2.0, tolerance_px=0.6)
        else:
            layer = polygons_deeper_than(gen, depth, min_area_px=8.0, tolerance_px=0.9)
        features.extend(layer)
        print(f'  {depth:>5} m: {len(layer)} polygons ({time.time() - t0:.0f}s)', flush=True)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f, separators=(',', ':'))
    print(f'Wrote {OUT}: {os.path.getsize(OUT) / 1e6:.1f} MB, {len(features)} polygons ({time.time() - t0:.0f}s)')


if __name__ == '__main__':
    sys.exit(main())
