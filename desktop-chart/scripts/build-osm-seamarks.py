#!/usr/bin/env python3
"""Builds the built-in worldwide seamarks (src/maps/seamarks/*.json) from OpenStreetMap
(© OpenStreetMap contributors, ODbL 1.0): lights, buoys, beacons, wrecks, rocks, obstructions,
harbours, anchorages, fog signals … mapped with the OpenSeaMap seamark:* tags.

The tags follow the S-57 object model, so each node becomes an S-57-like feature
({c: 'BOYLAT', a: {COLOUR: '4', ...}}) that renderer/enc-layer.js draws with its S-52 symbology.
Features are grouped in 10°x10° squares (compact JSON, see below), listed in index.json, loaded only when visible.

Reads the Daylight Map Distribution of OSM (Parquet, AWS Open Data s3://daylight-openstreetmap): only the
tags and positions of tagged nodes are fetched.
Usage: pip install pyarrow && python3 scripts/build-osm-seamarks.py   (SOURCE=daylight for a quick partial build)
"""

import json
import math
import os
import re
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import pyarrow.compute as pc
import pyarrow.fs as pafs
import pyarrow.orc as orc
import pyarrow.parquet as pq

# Daylight Map Distribution: OSM features with tags as Parquet (only tagged nodes, ~10 GB to scan).
RELEASE = os.environ.get('DAYLIGHT_RELEASE', 'v1.58')
NODES = f'daylight-openstreetmap/parquet/osm_features/release={RELEASE}/type=node'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src', 'maps', 'seamarks')
CACHE = os.path.join(ROOT, '.cache', f'osm-seamark-nodes-{RELEASE}.jsonl')
WORKERS = int(os.environ.get('WORKERS', 48))  # S3 throughput grows with the number of streams
SQUARE = 10

_local = threading.local()


def s3():
    if not hasattr(_local, 'fs'):
        _local.fs = pafs.S3FileSystem(anonymous=True, region='us-west-2')
    return _local.fs


def retry(fn):
    def wrapped(*args):
        for attempt in range(6):
            try:
                return fn(*args)
            except Exception as e:  # transient S3/network errors
                if attempt == 5:
                    raise
                print(f'  retry {fn.__name__}{args[:1]}: {e}', flush=True)
                if hasattr(_local, 'fs'):
                    del _local.fs
                time.sleep(2 ** attempt)
    return wrapped


@retry
def scan(job):
    path, rg = job
    t = pq.ParquetFile(s3().open_input_file(path)).read_row_group(rg, columns=['tags', 'min_lon', 'min_lat'])
    tags = t.column('tags')
    hit = pc.fill_null(pc.is_valid(pc.map_lookup(tags, 'seamark:type', 'first')), False)
    out = []
    for row in t.filter(hit).to_pylist():
        kv = {k: v for k, v in row['tags'] if k.startswith('seamark:') or k == 'name'}
        out.append({'lat': row['min_lat'], 'lon': row['min_lon'], 't': kv})
    return out


def extract():
    if os.path.exists(CACHE):
        with open(CACHE) as f:
            return [json.loads(line) for line in f]
    files = [i.path for i in s3().get_file_info(pafs.FileSelector(NODES, recursive=True)) if i.type == pafs.FileType.File]
    jobs = [(p, rg) for p in files for rg in range(pq.ParquetFile(s3().open_input_file(p)).metadata.num_row_groups)]
    print(f'scanning {len(jobs)} row groups in {len(files)} files', flush=True)
    nodes = []
    t0 = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        for n, part in enumerate(pool.map(scan, jobs), 1):
            nodes.extend(part)
            if n % 10 == 0:
                print(f'  {n}/{len(jobs)} row groups, {len(nodes)} seamarks ({time.time() - t0:.0f}s)', flush=True)
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, 'w') as f:
        for n in nodes:
            f.write(json.dumps(n) + '\n')
    return nodes


# The full planet (ORC, s3://osm-pds) has every seamark node; Daylight's feature table above is much
# smaller to scan but leaves out most buoys. SOURCE=orc (default) or SOURCE=daylight.
SOURCE = os.environ.get('SOURCE', 'orc')
PLANET = 'osm-pds/planet/planet-latest.orc'
_orc = threading.local()


def planet():
    if not hasattr(_orc, 'f'):
        _orc.f = orc.ORCFile(pafs.S3FileSystem(anonymous=True, region='us-east-1').open_input_file(PLANET))
    return _orc.f


def node_stripes():
    f = planet()
    lo, hi = 0, f.nstripes - 1
    while lo < hi:  # first stripe that does not start with a node
        m = (lo + hi) // 2
        if planet().read_stripe(m, columns=['type']).column(0)[0].as_py() == 'node':
            lo = m + 1
        else:
            hi = m
    return list(range(0, lo))


STRIPE_CACHE = os.path.join(ROOT, '.cache', 'osm-seamark-stripes')


def scan_stripe(i):
    # Each stripe's result is kept on disk, so an interrupted scan resumes where it stopped.
    done = os.path.join(STRIPE_CACHE, f'{i:05d}.json')
    if os.path.exists(done):
        with open(done) as f:
            return json.load(f)
    out = scan_stripe_s3(i)
    with open(done + '.tmp', 'w') as f:
        json.dump(out, f)
    os.replace(done + '.tmp', done)
    return out


def scan_stripe_s3(i):
    for attempt in range(6):
        try:
            t = planet().read_stripe(i, columns=['tags', 'lat', 'lon'])
            break
        except Exception as e:
            if attempt == 5:
                raise
            print(f'  retry stripe {i}: {e}', flush=True)
            if hasattr(_orc, 'f'):
                del _orc.f
            time.sleep(2 ** attempt)
    hit = pc.fill_null(pc.is_valid(pc.map_lookup(t.column('tags'), 'seamark:type', 'first')), False)
    hit = pc.and_(hit, pc.is_valid(t.column('lat')))
    out = []
    for row in t.filter(hit).to_pylist():
        kv = {k: v for k, v in row['tags'] if k.startswith('seamark:') or k == 'name'}
        out.append({'lat': float(row['lat']), 'lon': float(row['lon']), 't': kv})
    return out


def extract_orc():
    cache = os.path.join(ROOT, '.cache', 'osm-seamark-nodes-planet.jsonl')
    if os.path.exists(cache):
        with open(cache) as f:
            return [json.loads(line) for line in f]
    os.makedirs(STRIPE_CACHE, exist_ok=True)
    stripes = node_stripes()
    print(f'scanning {len(stripes)} node stripes of the planet', flush=True)
    nodes = []
    t0 = time.time()
    with ThreadPoolExecutor(int(os.environ.get('WORKERS', 128))) as pool:
        for n, part in enumerate(pool.map(scan_stripe, stripes), 1):
            nodes.extend(part)
            if n % 50 == 0 or n == len(stripes):
                print(f'  {n}/{len(stripes)} stripes, {len(nodes)} seamarks ({time.time() - t0:.0f}s)', flush=True)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, 'w') as f:
        for n in nodes:
            f.write(json.dumps(n) + '\n')
    return nodes


# --- OpenSeaMap tags -> S-57 -------------------------------------------------------------------

CLASSES = {
    'buoy_lateral': 'BOYLAT', 'buoy_cardinal': 'BOYCAR', 'buoy_isolated_danger': 'BOYISD', 'buoy_safe_water': 'BOYSAW',
    'buoy_special_purpose': 'BOYSPP', 'buoy_installation': 'BOYINB',
    'beacon_lateral': 'BCNLAT', 'beacon_cardinal': 'BCNCAR', 'beacon_isolated_danger': 'BCNISD', 'beacon_safe_water': 'BCNSAW',
    'beacon_special_purpose': 'BCNSPP',
    'light_major': 'LIGHTS', 'light_minor': 'LIGHTS', 'light': 'LIGHTS', 'light_vessel': 'LITVES', 'light_float': 'LITFLT',
    'landmark': 'LNDMRK', 'wreck': 'WRECKS', 'rock': 'UWTROC', 'obstruction': 'OBSTRN', 'fog_signal': 'FOGSIG',
    'radar_transponder': 'RTPBCN', 'radio_station': 'RDOSTA', 'radar_station': 'RADSTA', 'signal_station_traffic': 'SISTAT',
    'signal_station_warning': 'SISTAW', 'rescue_station': 'RSCSTA', 'coastguard_station': 'CGUSTA', 'pilot_boarding': 'PILBOP',
    'anchorage': 'ACHARE', 'anchor_berth': 'ACHBRT', 'harbour': 'HRBFAC', 'mooring': 'MORFAC', 'small_craft_facility': 'SMCFAC',
    'pile': 'PILPNT', 'daymark': 'DAYMAR', 'topmark': 'TOPMAR', 'notice': 'NOTMRK', 'distance_mark': 'DISMAR',
    'platform': 'OFSPLF', 'offshore_platform': 'OFSPLF', 'calling-in_point': 'CALPNT', 'bridge': 'BRIDGE', 'tower': 'LNDMRK',
    'sounding': 'SOUNDG', 'seabed_area': 'SBDARE', 'restricted_area': 'RESARE', 'berth': 'BERTHS', 'gate': 'GATCON',
    'lock_basin': 'LOKBSN', 'harbour_basin': 'HRBBSN', 'dry_dock': 'DRYDOC', 'checkpoint': 'CHKPNT', 'crane': 'CRANES',
}
COLOURS = {'white': '1', 'black': '2', 'red': '3', 'green': '4', 'blue': '5', 'yellow': '6', 'grey': '7', 'gray': '7',
           'brown': '8', 'amber': '9', 'violet': '10', 'orange': '11', 'magenta': '12', 'pink': '13'}
SHAPES = {'conical': '1', 'can': '2', 'spherical': '3', 'pillar': '4', 'spar': '5', 'barrel': '6', 'super-buoy': '7', 'ice_buoy': '8'}
BCN_SHAPES = {'stake': '1', 'pole': '1', 'perch': '1', 'post': '1', 'withy': '2', 'tower': '3', 'lattice': '4', 'pile': '5', 'cairn': '6', 'buoyant': '7'}
PATTERNS = {'horizontal': '1', 'vertical': '2', 'diagonal': '3', 'squared': '4', 'stripes': '5', 'border': '6'}
LIGHT_CHR = {'F': '1', 'Fl': '2', 'LFl': '3', 'Q': '4', 'VQ': '5', 'UQ': '6', 'Iso': '7', 'Oc': '8', 'IQ': '9', 'IVQ': '10',
             'IUQ': '11', 'Mo': '12', 'FFl': '13', 'FlLFl': '14', 'OcFl': '15', 'FLFl': '16', 'Al.Oc': '17', 'Al.LFl': '18',
             'Al.Fl': '19', 'Al.Gr': '20', 'Q+LFl': '25', 'VQ+LFl': '26', 'UQ+LFl': '27', 'Al': '28', 'Al.FFl': '29'}
LAT_CAT = {'port': '1', 'starboard': '2', 'preferred_channel_starboard': '3', 'preferred_channel_port': '4'}
CARD_CAT = {'north': '1', 'east': '2', 'south': '3', 'west': '4'}
WATER_LEVEL = {'partly_submerged': '1', 'dry': '2', 'submerged': '3', 'covers': '4', 'awash': '5', 'floods': '6', 'floating': '7'}
SURFACE = {'mud': '1', 'clay': '2', 'silt': '3', 'sand': '4', 'stone': '5', 'gravel': '6', 'pebbles': '7', 'cobbles': '8',
           'rock': '9', 'lava': '11', 'coral': '14', 'shells': '17', 'boulder': '18'}
LANDMARK = {'tower': '17', 'chimney': '3', 'mast': '7', 'windmotor': '20', 'monument': '9', 'flagstaff': '5', 'cairn': '1',
            'column': '6', 'dish_aerial': '4', 'spire': '18', 'dome': '8', 'windmill': '19', 'minaret': '18'}

NUM = re.compile(r'^-?\d+(\.\d+)?$')


def number(v):
    if v is None:
        return None
    v = v.strip().replace(',', '.').rstrip('msMNkn ').strip()
    return v if NUM.match(v) else None


def colours(v):
    if not v:
        return None
    codes = [COLOURS.get(c.strip()) for c in re.split(r'[;,]', v)]
    codes = [c for c in codes if c]
    return ','.join(codes) or None


def light_attrs(t, prefix):
    g = lambda k: t.get(f'{prefix}:{k}')
    a = {}
    chr_ = g('character')
    if chr_:
        a['LITCHR'] = LIGHT_CHR.get(chr_.replace(' ', ''), LIGHT_CHR.get(chr_.split('(')[0].strip(), ''))
    grp = g('group')
    if grp:
        a['SIGGRP'] = f'({grp.strip("()")})'
    for key, attr in (('period', 'SIGPER'), ('range', 'VALNMR'), ('height', 'HEIGHT')):
        n = number(g(key))
        if n:
            a[attr] = n
    c = colours(g('colour'))
    if c:
        a['COLOUR'] = c
    s1, s2 = number(g('sector_start')), number(g('sector_end'))
    if s1 and s2:
        a['SECTR1'], a['SECTR2'] = s1, s2
    return {k: v for k, v in a.items() if v}


# Inland-waterway and marina objects (gates, km marks, mooring posts, piles) that only clutter a seagoing chart.
SKIP = {'MORFAC', 'PILPNT', 'GATCON', 'DISMAR', 'NOTMRK', 'BRIDGE', 'CRANES', 'BERTHS', 'CHKPNT', 'LOKBSN', 'HRBBSN', 'DRYDOC'}


def convert(node):
    t = node['t']
    typ = t.get('seamark:type', '')
    cls = CLASSES.get(typ)
    if not cls or cls in SKIP:
        return []
    g = lambda k: t.get(f'seamark:{typ}:{k}')
    a = {}
    name = t.get('seamark:name') or t.get('name')
    if name:
        a['OBJNAM'] = name[:60]
    c = colours(g('colour'))
    if c:
        a['COLOUR'] = c
    p = g('colour_pattern')
    if p and p in PATTERNS:
        a['COLPAT'] = PATTERNS[p]
    shape = g('shape')
    if cls.startswith('BOY') and shape in SHAPES:
        a['BOYSHP'] = SHAPES[shape]
    if cls.startswith('BCN') and shape in BCN_SHAPES:
        a['BCNSHP'] = BCN_SHAPES[shape]
    cat = g('category')
    if cls in ('BOYLAT', 'BCNLAT') and cat in LAT_CAT:
        a['CATLAM'] = LAT_CAT[cat]
    if cls in ('BOYCAR', 'BCNCAR') and cat in CARD_CAT:
        a['CATCAM'] = CARD_CAT[cat]
    if cls == 'LNDMRK' and (cat or typ) in LANDMARK:
        a['CATLMK'] = LANDMARK[cat or typ]
    if t.get(f'seamark:{typ}:conspicuity') == 'conspicuous' or t.get('seamark:landmark:conspicuity') == 'conspicuous':
        a['CONVIS'] = '1'
    if cls in ('WRECKS', 'UWTROC', 'OBSTRN'):
        d = number(g('depth')) or number(t.get('seamark:depth'))
        if d:
            a['VALSOU'] = d
        wl = g('water_level') or t.get('seamark:water_level')
        if wl in WATER_LEVEL:
            a['WATLEV'] = WATER_LEVEL[wl]
        if cls == 'WRECKS' and cat:
            a['CATWRK'] = {'non-dangerous': '1', 'dangerous': '2', 'distributed_remains': '3', 'mast_showing': '4', 'hull_showing': '5'}.get(cat, '')
    if cls == 'SBDARE':
        s = colours_or(g('surface'), SURFACE)
        if s:
            a['NATSUR'] = s
    if cls == 'FOGSIG':
        cat_ = g('category')
        if cat_:
            a['CATFOG'] = cat_
    lon = round(node['lon'], 6)
    lat = round(node['lat'], 6)
    feats = []
    if cls != 'LIGHTS':
        feats.append({'c': cls, 'a': {k: v for k, v in a.items() if v}, 'p': [lon, lat]})
    # Lights: the main light, or one feature per sector (seamark:light:1:…, seamark:light:2:…).
    sectors = sorted({m.group(1) for k in t for m in [re.match(r'seamark:light:(\d+):', k)] if m}, key=int)
    lights = [light_attrs(t, f'seamark:light:{s}') for s in sectors] or [light_attrs(t, 'seamark:light')]
    for la in lights:
        if not la:
            continue
        if cls == 'LIGHTS' and name:
            la['OBJNAM'] = a['OBJNAM']
        feats.append({'c': 'LIGHTS', 'a': la, 'p': [lon, lat]})
    if cls == 'LIGHTS' and not any(f['c'] == 'LIGHTS' for f in feats):
        feats.append({'c': 'LIGHTS', 'a': {k: v for k, v in a.items() if v}, 'p': [lon, lat]})
    return feats


def colours_or(v, table):
    if not v:
        return None
    codes = [table.get(c.strip()) for c in re.split(r'[;,]', v)]
    return ','.join(c for c in codes if c) or None


def main():
    nodes = extract_orc() if SOURCE == 'orc' else extract()
    print(f'{len(nodes)} seamark nodes', flush=True)
    squares = defaultdict(list)
    counts = defaultdict(int)
    for n in nodes:
        for f in convert(n):
            counts[f['c']] += 1
            sx = math.floor(f['p'][0] / SQUARE) * SQUARE
            sy = math.floor(f['p'][1] / SQUARE) * SQUARE
            squares[(sx, sy)].append(f)
    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):
        os.remove(os.path.join(OUT, old))
    index = []
    for (sx, sy), feats in sorted(squares.items()):
        name = f'OSM_{"E" if sx >= 0 else "W"}{abs(sx):03d}_{"N" if sy >= 0 else "S"}{abs(sy):02d}'
        # Compact: {k: [classes], f: [[class index, lon, lat, attributes?]]}; enc-layer.js expands it.
        classes = sorted({f['c'] for f in feats})
        rows = [[classes.index(f['c']), f['p'][0], f['p'][1]] + ([f['a']] if f['a'] else []) for f in feats]
        with open(os.path.join(OUT, f'{name}.json'), 'w') as fh:
            json.dump({'k': classes, 'f': rows}, fh, separators=(',', ':'), ensure_ascii=False)
        lons = [f['p'][0] for f in feats]
        lats = [f['p'][1] for f in feats]
        index.append({'name': name, 'bbox': [min(lons), min(lats), max(lons), max(lats)], 'features': len(feats)})
    with open(os.path.join(OUT, 'index.json'), 'w') as fh:
        json.dump(index, fh, separators=(',', ':'))
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f'{len(index)} squares, {sum(counts.values())} features, {total / 1e6:.1f} MB', flush=True)
    print(dict(sorted(counts.items(), key=lambda kv: -kv[1])), flush=True)


if __name__ == '__main__':
    main()
