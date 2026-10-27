#!/usr/bin/env python3
"""Builds the detailed built-in coastline: src/maps/land/*.bin, OpenStreetMap land polygons
(© OpenStreetMap contributors, ODbL 1.0) simplified to about 20 m and cut into 5°x5° squares.

Source: the Daylight Map Distribution "earth" table on AWS Open Data (s3://daylight-openstreetmap/earth,
theme=land, class=land), i.e. the land polygons generated from OSM natural=coastline.

File format (little endian), read by renderer/coast-layer.js:
  uint32 polygon count; per polygon: uint32 ring count; per ring: uint32 point count, then the points as
  zigzag varints of the deltas of round(lon * 1e5), round(lat * 1e5) from the previous point
  (the first point of every polygon is relative to the square's south-west corner).
index.json lists the squares with their polygon and point counts.

Usage: pip install pyarrow shapely numpy && python3 scripts/build-osm-land.py
"""

import json
import math
import os
import struct
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyarrow.compute as pc
import pyarrow.fs as pafs
import pyarrow.parquet as pq
import shapely

RELEASE = os.environ.get('DAYLIGHT_RELEASE', 'v1.58')
LAND = f'daylight-openstreetmap/earth/release={RELEASE}/theme=land'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src', 'maps', 'land')
CACHE = os.path.join(ROOT, '.cache', f'osm-land-{RELEASE}')
WORKERS = int(os.environ.get('WORKERS', 32))
SQUARE = 5
TOLERANCE = float(os.environ.get('TOLERANCE', 0.0002))  # degrees, ~20 m
MIN_AREA = TOLERANCE * TOLERANCE * 4  # drop slivers smaller than a few pixels at zoom 14

_local = threading.local()


def s3():
    if not hasattr(_local, 'fs'):
        _local.fs = pafs.S3FileSystem(anonymous=True, region='us-west-2')
    return _local.fs


def scan(job):
    path, rg, n = job
    out_file = os.path.join(CACHE, f'{n:04d}.wkb')
    if os.path.exists(out_file):
        return out_file
    for attempt in range(6):
        try:
            f = pq.ParquetFile(s3().open_input_file(path))
            cls = f.read_row_group(rg, columns=['class']).column(0)
            mask = pc.fill_null(pc.equal(cls, 'land'), False)
            if not pc.any(mask).as_py():
                geoms = []
            else:
                wkt = f.read_row_group(rg, columns=['wkt']).column(0).filter(mask).to_numpy(zero_copy_only=False)
                geoms = shapely.from_wkt(wkt)
            break
        except Exception as e:
            if attempt == 5:
                raise
            print(f'  retry {n}: {e}', flush=True)
            if hasattr(_local, 'fs'):
                del _local.fs
            time.sleep(2 ** attempt)
    geoms = shapely.simplify(np.asarray(geoms), TOLERANCE, preserve_topology=True) if len(geoms) else []
    with open(out_file + '.tmp', 'wb') as fh:
        for g in geoms:
            if g is None or g.is_empty or g.area < MIN_AREA:
                continue
            b = shapely.to_wkb(g)
            fh.write(struct.pack('<I', len(b)) + b)
    os.replace(out_file + '.tmp', out_file)
    return out_file


def read_cache(fname):
    out = []
    with open(fname, 'rb') as fh:
        data = fh.read()
    i = 0
    while i < len(data):
        (n,) = struct.unpack_from('<I', data, i)
        out.append(shapely.from_wkb(data[i + 4:i + 4 + n]))
        i += 4 + n
    return out


def varint(v, buf):
    v = (v << 1) ^ (v >> 63)  # zigzag
    while True:
        b = v & 0x7f
        v >>= 7
        if v:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            return


def polygons(g):
    if g.geom_type == 'Polygon':
        yield g
    elif g.geom_type in ('MultiPolygon', 'GeometryCollection'):
        for p in g.geoms:
            yield from polygons(p)


def merge(parts):
    arr = np.asarray(parts)
    for attempt in (lambda: shapely.union_all(arr, grid_size=1e-5),
                    lambda: shapely.union_all(shapely.make_valid(arr), grid_size=1e-5),
                    lambda: shapely.union_all(shapely.make_valid(arr))):
        try:
            return attempt()
        except shapely.errors.GEOSException as e:
            print(f'  union retry: {e}', flush=True)
    return shapely.GeometryCollection(list(parts))


def main():
    os.makedirs(CACHE, exist_ok=True)
    files = sorted(i.path for i in s3().get_file_info(pafs.FileSelector(LAND, recursive=True)) if i.type == pafs.FileType.File)
    jobs = []
    for p in files:
        for rg in range(pq.ParquetFile(s3().open_input_file(p)).metadata.num_row_groups):
            jobs.append((p, rg, len(jobs)))
    print(f'{len(jobs)} row groups in {len(files)} files', flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        for n, _ in enumerate(pool.map(scan, jobs), 1):
            if n % 10 == 0:
                print(f'  {n}/{len(jobs)} row groups ({time.time() - t0:.0f}s)', flush=True)

    squares = defaultdict(list)
    for n in range(len(jobs)):
        for g in read_cache(os.path.join(CACHE, f'{n:04d}.wkb')):
            w, s, e, nn = g.bounds
            for sx in range(math.floor(w / SQUARE) * SQUARE, math.floor(e / SQUARE) * SQUARE + 1, SQUARE):
                for sy in range(math.floor(s / SQUARE) * SQUARE, math.floor(nn / SQUARE) * SQUARE + 1, SQUARE):
                    part = g if (w >= sx and e <= sx + SQUARE and s >= sy and nn <= sy + SQUARE) else \
                        shapely.clip_by_rect(g, sx, sy, sx + SQUARE, sy + SQUARE)
                    for p in polygons(part):
                        if p.area >= MIN_AREA:
                            squares[(sx, sy)].append(p)

    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):
        os.remove(os.path.join(OUT, old))
    index = []
    total = 0
    for (sx, sy), parts in sorted(squares.items()):
        # The source polygons are cut by a quadtree; merging them removes the cut lines, so that only
        # real coastline (and the square's own edges, which the renderer skips) gets stroked.
        merged = merge(parts)
        polys = [p for p in polygons(merged) if p.area >= MIN_AREA]
        buf = bytearray(struct.pack('<I', len(polys)))
        points = 0
        for p in polys:
            rings = [p.exterior] + list(p.interiors)
            buf += struct.pack('<I', len(rings))
            px, py = round(sx * 1e5), round(sy * 1e5)
            for r in rings:
                c = np.round(np.asarray(r.coords)[:-1] * 1e5).astype(np.int64)
                buf += struct.pack('<I', len(c))
                points += len(c)
                for x, y in c:
                    varint(int(x - px), buf)
                    varint(int(y - py), buf)
                    px, py = x, y
        name = f'L_{"E" if sx >= 0 else "W"}{abs(sx):03d}_{"N" if sy >= 0 else "S"}{abs(sy):02d}'
        with open(os.path.join(OUT, f'{name}.bin'), 'wb') as fh:
            fh.write(buf)
        total += len(buf)
        index.append({'name': name, 'bbox': [sx, sy, sx + SQUARE, sy + SQUARE], 'polygons': len(polys), 'points': points})
    with open(os.path.join(OUT, 'index.json'), 'w') as fh:
        json.dump(index, fh, separators=(',', ':'))
    print(f'{len(index)} squares, {sum(i["points"] for i in index)} points, {total / 1e6:.1f} MB', flush=True)


if __name__ == '__main__':
    main()
