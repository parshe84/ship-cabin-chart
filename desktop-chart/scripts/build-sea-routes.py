#!/usr/bin/env python3
"""Builds the offline sea-route network and the world port-to-port distance table.

Source: the MARNET maritime network and port list bundled with searoute-py
(https://github.com/genthalili/searoute-py, Apache-2.0), derived from Eurostat's SeaRoute
(https://github.com/eurostat/searoute) and the ORNL global shipping lane network.

Writes:
  src/maps/world/sea-routes.json      graph (nodes, edges in nautical miles, passages) + ports
  src/maps/world/distance-table.json  shortest sea distances between major world ports

Usage: python3 scripts/build-sea-routes.py   (downloads searoute from PyPI into .cache/)
"""

import heapq
import io
import json
import math
import os
import tarfile
import urllib.request

VERSION = '1.6.0'
SDIST = f'https://files.pythonhosted.org/packages/source/s/searoute/searoute-{VERSION}.tar.gz'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache', f'searoute-{VERSION}.tar.gz')
OUT_DIR = os.path.join(ROOT, 'src', 'maps', 'world')

# Major ports for the distance table (UN/LOCODE), grouped roughly by region.
TABLE_PORTS = [
    'NOOSL', 'RULED', 'DEHAM', 'NLRTM', 'BEANR', 'GBLON', 'GBSOU', 'FRLEH', 'ESALG', 'ESBCN',
    'ITGOA', 'GRPIR', 'TRIST', 'RUNVS', 'EGPSD', 'SAJED', 'AEJEA', 'OMSLL', 'INBOM', 'LKCMB',
    'SGSIN', 'IDJKT', 'HKHKG', 'CNSHA', 'KRPUS', 'JPYOK', 'RUVVO', 'AUSYD', 'AUMEL', 'NZAKL',
    'ZADUR', 'ZACPT', 'NGLOS', 'BRSSZ', 'BRRIO', 'ARBUE', 'CLVAP', 'PECLL', 'PABLB', 'PACTB', 'USHOU',
    'USMIA', 'USNYC', 'CAHAL', 'USLAX', 'USSEA', 'CAVAN',
]

# Published reference distances (nautical miles, rounded) used as a sanity check.
REFERENCE = [
    ('NLRTM', 'SGSIN', 8290),  # via Suez
    ('CNSHA', 'USLAX', 5710),
    ('SGSIN', 'HKHKG', 1460),
    ('GBSOU', 'USNYC', 3150),
    ('USNYC', 'USLAX', 4950),  # via Panama
    ('NLRTM', 'USNYC', 3460),
]


def haversine_nm(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlon = lon2 - lon1
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 3440.065 * math.asin(math.sqrt(min(1.0, h)))


def load_source():
    if not os.path.exists(CACHE):
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        with urllib.request.urlopen(SDIST, timeout=120) as r, open(CACHE, 'wb') as f:
            f.write(r.read())
    with tarfile.open(CACHE) as tar:
        def read(name):
            return json.load(tar.extractfile(f'searoute-{VERSION}/searoute/data/{name}'))
        return read('marnet_searoute.geojson'), read('ports.geojson')


def lines_of(geometry):
    if geometry['type'] == 'LineString':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiLineString':
        return geometry['coordinates']
    return []


def build_graph(marnet):
    nodes, index, edges = [], {}, {}
    passages = []

    def node(c):
        key = (round(c[0], 4), round(c[1], 4))
        if key not in index:
            index[key] = len(nodes)
            nodes.append(key)
        return index[key]

    for f in marnet['features']:
        passage = (f.get('properties') or {}).get('passage')
        if passage == 'segment':
            continue  # helper geometry along the antimeridian, not a route
        p = 0
        if passage:
            if passage not in passages:
                passages.append(passage)
            p = passages.index(passage) + 1
        for line in lines_of(f['geometry']):
            for a, b in zip(line, line[1:]):
                i, j = node(a), node(b)
                if i == j:
                    continue
                key = (min(i, j), max(i, j))
                d = haversine_nm(nodes[i], nodes[j])
                if key not in edges or edges[key][0] > d:
                    edges[key] = (d, p)

    # Stitch the antimeridian: a node at lon 180 is the same place as one at lon -180.
    for (lon, lat), i in list(index.items()):
        if lon == 180 and (-180, lat) in index:
            j = index[(-180, lat)]
            edges[(min(i, j), max(i, j))] = (0.0, 0)

    adj = [[] for _ in nodes]
    for (i, j), (d, p) in edges.items():
        adj[i].append((j, d))
        adj[j].append((i, d))
    return nodes, edges, passages, adj


def nearest_node(nodes, adj, lonlat):
    best, best_d = None, float('inf')
    for i, n in enumerate(nodes):
        if not adj[i]:
            continue
        d = haversine_nm(n, lonlat)
        if d < best_d:
            best, best_d = i, d
    return best, best_d


def dijkstra(adj, src):
    dist = [float('inf')] * len(adj)
    dist[src] = 0.0
    heap = [(0.0, src)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u]:
            continue
        for v, w in adj[u]:
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd
                heapq.heappush(heap, (nd, v))
    return dist


def main():
    marnet, ports_geo = load_source()
    nodes, edges, passages, adj = build_graph(marnet)
    print(f'network: {len(nodes)} nodes, {len(edges)} edges, passages: {", ".join(passages)}')

    ports = []
    by_code = {}
    for f in ports_geo['features']:
        pr = f['properties']
        lon, lat = f['geometry']['coordinates'][:2]
        n, snap = nearest_node(nodes, adj, (lon, lat))
        by_code[pr['port']] = len(ports)
        ports.append([pr['name'], pr['port'], pr.get('cty', ''), round(lon, 4), round(lat, 4), n, round(snap, 1)])
    print(f'ports: {len(ports)}')

    def port_distance(dist_from, a, b):
        pa, pb = ports[a], ports[b]
        return pa[6] + dist_from[pb[5]] + pb[6]

    table_idx = [by_code[c] for c in TABLE_PORTS if c in by_code]
    missing = [c for c in TABLE_PORTS if c not in by_code]
    if missing:
        print('missing table ports:', missing)
    matrix = []
    cache = {}
    for a in table_idx:
        dist = cache.setdefault(ports[a][5], dijkstra(adj, ports[a][5]))
        matrix.append([0 if a == b else round(port_distance(dist, a, b)) for b in table_idx])

    print('check against published distances:')
    for ca, cb, ref in REFERENCE:
        a, b = by_code[ca], by_code[cb]
        dist = cache.get(ports[a][5]) or dijkstra(adj, ports[a][5])
        got = port_distance(dist, a, b)
        print(f'  {ca}-{cb}: {got:7.0f} nm (published ~{ref}, {100 * (got - ref) / ref:+.1f}%)')

    network = {
        'source': 'MARNET via searoute-py (Apache-2.0) / Eurostat SeaRoute',
        'passages': passages,
        'nodes': [[n[0], n[1]] for n in nodes],
        'edges': [[i, j, round(d, 2), p] for (i, j), (d, p) in edges.items()],
        'ports': ports,  # [name, locode, country, lon, lat, node, snap distance nm]
    }
    with open(os.path.join(OUT_DIR, 'sea-routes.json'), 'w') as f:
        json.dump(network, f, separators=(',', ':'))
    table = {
        'ports': [[ports[i][0], ports[i][1], ports[i][2]] for i in table_idx],
        'nm': matrix,
    }
    with open(os.path.join(OUT_DIR, 'distance-table.json'), 'w') as f:
        json.dump(table, f, separators=(',', ':'))
    for name in ('sea-routes.json', 'distance-table.json'):
        print(f'wrote {name}: {os.path.getsize(os.path.join(OUT_DIR, name)) / 1e3:.0f} kB')


if __name__ == '__main__':
    main()
