#!/usr/bin/env python3
"""Builds src/maps/world/maritime.json from OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0):

  - Traffic separation schemes (IMO routeing measures mapped as seamark:type=separation_*,
    inshore_traffic_zone, precautionary_area)
  - Maritime boundaries: territorial sea limits (12 nm), contiguous zone (24 nm), EEZ and baselines
    (boundary=maritime + border_type, and maritime=yes parts of national borders)

Reads the planet in ORC format straight from the AWS Open Data bucket (s3://osm-pds), fetching only the
columns it needs: tags of all ways, then node coordinates for the matching ways. No 130 GB download.

Usage: pip install pyarrow numpy shapely && python3 scripts/build-osm-maritime.py
"""

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.fs as pafs
import pyarrow.orc as orc
from shapely.geometry import LineString

PLANET = 'osm-pds/planet/planet-latest.orc'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src', 'maps', 'world', 'maritime.json')
WORKERS = 32  # S3 throughput per stream is low; many parallel streams add up
CACHE = os.path.join(ROOT, '.cache', 'osm-maritime-ways.json')

TSS_TYPES = ['separation_line', 'separation_zone', 'separation_boundary', 'separation_lane',
             'separation_roundabout', 'separation_crossing', 'inshore_traffic_zone', 'precautionary_area']
BORDER_TYPES = ['territorial', 'contiguous', 'eez', 'baseline']

_local = threading.local()


def planet():
    if not hasattr(_local, 'f'):
        fs = pafs.S3FileSystem(anonymous=True, region='us-east-1')
        _local.f = orc.ORCFile(fs.open_input_file(PLANET))
    return _local.f


def retry(fn):
    def wrapped(*args):
        for attempt in range(6):
            try:
                return fn(*args)
            except Exception as e:  # transient S3/network errors
                if attempt == 5:
                    raise
                print(f'  retry {fn.__name__}{args[:1]}: {e}', flush=True)
                if hasattr(_local, 'f'):
                    del _local.f
                time.sleep(2 ** attempt)
    wrapped.__name__ = fn.__name__
    return wrapped


def first_type(i):
    return planet().read_stripe(i, columns=['type']).column(0)[0].as_py()


def stripe_ranges():
    f = planet()
    def search(pred):
        lo, hi = 0, f.nstripes - 1
        while lo < hi:
            m = (lo + hi) // 2
            if pred(first_type(m)):
                lo = m + 1
            else:
                hi = m
        return lo
    first_way = search(lambda t: t == 'node') - 1  # the stripe before may already hold the first ways
    first_rel = search(lambda t: t != 'relation')
    return max(0, first_way), first_rel


@retry
def scan_way_stripe(i):
    f = planet()
    tb = f.read_stripe(i, columns=['type', 'id', 'tags'])
    tags = tb.column('tags')
    look = lambda k: pc.map_lookup(tags, k, 'first')
    st, b, bt, mar, al = look('seamark:type'), look('boundary'), look('border_type'), look('maritime'), look('admin_level')
    # Missing tags are nulls, and null OR true is null in Arrow: turn every test into a plain bool first.
    yes = lambda m: pc.fill_null(m, False)
    is_way = yes(pc.equal(tb.column('type'), 'way'))
    tss = yes(pc.is_in(st, value_set=pa.array(TSS_TYPES)))
    border = pc.and_(yes(pc.equal(b, 'maritime')), yes(pc.is_in(bt, value_set=pa.array(BORDER_TYPES))))
    national = pc.and_(pc.and_(yes(pc.equal(mar, 'yes')), yes(pc.equal(b, 'administrative'))), yes(pc.equal(al, '2')))
    mask = pc.and_(is_way, pc.or_(tss, pc.or_(border, national)))
    idx = np.flatnonzero(mask.to_numpy(zero_copy_only=False))
    if not len(idx):
        return []
    nds = f.read_stripe(i, columns=['nds']).column('nds')
    out = []
    names = look('name')
    for j in idx:
        j = int(j)
        s = st[j].as_py()
        if s in TSS_TYPES:
            kind = s
        elif b[j].as_py() == 'maritime':
            kind = bt[j].as_py()
        else:
            kind = 'territorial'
        refs = [n['ref'] for n in nds[j].as_py() or []]
        if len(refs) >= 2:
            out.append({'kind': kind, 'name': names[j].as_py(), 'refs': refs})
    return out


@retry
def node_stripe_bounds(i):
    ids = planet().read_stripe(i, columns=['id']).column('id').to_numpy()
    return i, int(ids.min()), int(ids.max())


@retry
def read_nodes(args):
    i, wanted = args
    tb = planet().read_stripe(i, columns=['id', 'lat', 'lon'])
    ids = tb.column('id').to_numpy()
    hit = np.isin(ids, wanted)
    if not hit.any():
        return {}
    lat = pc.cast(tb.column('lat'), pa.float64()).to_numpy(zero_copy_only=False)[hit]
    lon = pc.cast(tb.column('lon'), pa.float64()).to_numpy(zero_copy_only=False)[hit]
    return dict(zip(ids[hit].tolist(), zip(lon.tolist(), lat.tolist())))


def main():
    t0 = time.time()
    first_way, first_rel = stripe_ranges()
    print(f'way stripes {first_way}..{first_rel - 1}', flush=True)

    if os.path.exists(CACHE):
        with open(CACHE) as fh:
            ways = json.load(fh)
        print(f'{len(ways)} matching ways (cached)', flush=True)
    else:
        ways = []
        with ThreadPoolExecutor(WORKERS) as pool:
            for n, res in enumerate(pool.map(scan_way_stripe, range(first_way, first_rel)), 1):
                ways.extend(res)
                if n % 50 == 0:
                    print(f'  scanned {n} way stripes, {len(ways)} ways ({time.time() - t0:.0f}s)', flush=True)
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        with open(CACHE, 'w') as fh:
            json.dump(ways, fh)
        print(f'{len(ways)} matching ways', flush=True)

    wanted = np.unique(np.fromiter((r for w in ways for r in w['refs']), dtype=np.int64))
    print(f'{len(wanted)} nodes needed', flush=True)
    with ThreadPoolExecutor(WORKERS) as pool:
        bounds = list(pool.map(node_stripe_bounds, range(0, first_way + 1)))
    jobs = []
    for i, lo, hi in bounds:
        a, b = np.searchsorted(wanted, lo), np.searchsorted(wanted, hi, side='right')
        if b > a:
            jobs.append((i, wanted[a:b]))
    print(f'reading coordinates from {len(jobs)} node stripes ({time.time() - t0:.0f}s)', flush=True)
    coords = {}
    with ThreadPoolExecutor(WORKERS) as pool:
        for n, res in enumerate(pool.map(read_nodes, jobs), 1):
            coords.update(res)
            if n % 50 == 0:
                print(f'  {n}/{len(jobs)} node stripes ({time.time() - t0:.0f}s)', flush=True)

    features = []
    for w in ways:
        pts = [coords[r] for r in w['refs'] if r in coords]
        if len(pts) < 2:
            continue
        tss = w['kind'] in TSS_TYPES
        line = LineString(pts)
        # Boundaries are long and smooth: simplify to ~50 m. TSS keep full detail.
        if not tss:
            line = line.simplify(0.0005, preserve_topology=False)
        prec = 5 if tss else 4
        c = [[round(x, prec), round(y, prec)] for x, y in line.coords]
        closed = tss and len(c) >= 4 and c[0] == c[-1] and w['kind'] in (
            'separation_zone', 'separation_roundabout', 'inshore_traffic_zone', 'precautionary_area')
        props = {'kind': w['kind']}
        if w['name']:
            props['name'] = w['name']
        features.append({
            'type': 'Feature',
            'properties': props,
            'geometry': {'type': 'Polygon', 'coordinates': [c]} if closed else {'type': 'LineString', 'coordinates': c},
        })

    with open(OUT, 'w') as f:
        json.dump({
            'type': 'FeatureCollection',
            'attribution': '© OpenStreetMap contributors, ODbL 1.0',
            'features': features,
        }, f, separators=(',', ':'))
    kinds = {}
    for ft in features:
        kinds[ft['properties']['kind']] = kinds.get(ft['properties']['kind'], 0) + 1
    print(f'wrote {OUT}: {os.path.getsize(OUT) / 1e6:.1f} MB, {kinds} ({time.time() - t0:.0f}s)')


if __name__ == '__main__':
    main()
