'use strict';

// Navigation maths shared by the renderer and the unit tests: rhumb-line legs, sea routing
// over the MARNET network, route progress (distance to go, XTE, waypoint arrival) and a
// rolling speed average for ETAs. Works as a browser global (window.NavCore) or a CommonJS module.

(function (root) {
  const R_NM = 3440.065; // mean Earth radius in nautical miles
  const rad = Math.PI / 180;

  const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

  // Rhumb line (constant course): what a straight line on the Mercator chart means.
  function rhumb(a, b) {
    const [lat1, lon1] = a;
    const [lat2, lon2] = b;
    const phi1 = lat1 * rad, phi2 = lat2 * rad;
    const dPhi = phi2 - phi1;
    let dLambda = wrapLon(lon2 - lon1) * rad;
    const dPsi = Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
    const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(phi1);
    const distanceNm = Math.sqrt(dPhi * dPhi + q * q * dLambda * dLambda) * R_NM;
    const bearing = (Math.atan2(dLambda, dPsi) / rad + 360) % 360;
    return { distanceNm, bearing };
  }

  function greatCircleNm(a, b) {
    const [lat1, lon1] = a.map((v) => v * rad);
    const [lat2, lon2] = b.map((v) => v * rad);
    const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.sqrt(Math.min(1, h)));
  }

  function pathLengthNm(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += rhumb(points[i - 1], points[i]).distanceNm;
    return total;
  }

  // Shifts longitudes so consecutive points never jump across the antimeridian (for drawing).
  function unwrapPath(points) {
    const out = [];
    for (const [lat, lon] of points) {
      if (!out.length) {
        out.push([lat, lon]);
        continue;
      }
      const prev = out[out.length - 1][1];
      out.push([lat, prev + wrapLon(lon - prev)]);
    }
    return out;
  }

  // --- Sea routing over the MARNET graph ---

  class MinHeap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }
    push(item) {
      const a = this.items;
      a.push(item);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p][0] <= a[i][0]) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    }
    pop() {
      const a = this.items;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    }
  }

  class SeaRouter {
    // network: { nodes: [[lon, lat]], edges: [[i, j, nm, passage]], passages: [name], ports: [...] }
    constructor(network) {
      this.nodes = network.nodes;
      this.passages = network.passages;
      this.ports = network.ports || [];
      this.adj = this.nodes.map(() => []);
      for (const [i, j, nm, p] of network.edges) {
        this.adj[i].push([j, nm, p]);
        this.adj[j].push([i, nm, p]);
      }
    }

    nearestNode(lat, lon) {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < this.nodes.length; i++) {
        if (!this.adj[i].length) continue;
        const [nlon, nlat] = this.nodes[i];
        // Cheap prefilter on latitude before the trigonometry.
        if (Math.abs(nlat - lat) * 60 > bestD) continue;
        const d = greatCircleNm([lat, lon], [nlat, nlon]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return { node: best, distanceNm: bestD };
    }

    // Shortest sea path between two positions. `avoid` lists passage names (e.g. 'suez').
    // Returns { points: [[lat, lon]], distanceNm, passages: [names used] } or null.
    route(from, to, avoid = []) {
      const banned = new Set(avoid.map((name) => this.passages.indexOf(name) + 1).filter((p) => p > 0));
      const a = this.nearestNode(from[0], from[1]);
      const b = this.nearestNode(to[0], to[1]);
      if (a.node < 0 || b.node < 0) return null;

      const dist = new Float64Array(this.nodes.length).fill(Infinity);
      const prev = new Int32Array(this.nodes.length).fill(-1);
      const via = new Int16Array(this.nodes.length);
      const heap = new MinHeap();
      dist[a.node] = 0;
      heap.push([0, a.node]);
      while (heap.size) {
        const [d, u] = heap.pop();
        if (u === b.node) break;
        if (d > dist[u]) continue;
        for (const [v, w, p] of this.adj[u]) {
          if (p && banned.has(p)) continue;
          const nd = d + w;
          if (nd < dist[v]) {
            dist[v] = nd;
            prev[v] = u;
            via[v] = p;
            heap.push([nd, v]);
          }
        }
      }
      if (!Number.isFinite(dist[b.node])) return null;

      const nodePath = [];
      const used = new Set();
      for (let n = b.node; n !== -1; n = prev[n]) {
        nodePath.push(n);
        if (via[n]) used.add(this.passages[via[n] - 1]);
      }
      nodePath.reverse();
      const points = [from, ...nodePath.map((n) => [this.nodes[n][1], this.nodes[n][0]]), to];
      const simplified = dropDuplicates(points);
      return {
        points: unwrapPath(simplified),
        distanceNm: a.distanceNm + dist[b.node] + b.distanceNm,
        passages: [...used],
      };
    }
  }

  function dropDuplicates(points) {
    return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || wrapLon(p[1] - points[i - 1][1]) !== 0);
  }

  // --- Following a route ---

  // Local flat projection around `origin` in nautical miles (good for XTE over a single leg).
  function toLocal(origin, p) {
    const x = wrapLon(p[1] - origin[1]) * 60 * Math.cos(origin[0] * rad);
    const y = (p[0] - origin[0]) * 60;
    return [x, y];
  }

  // Progress along `waypoints` (index 0 = start) for a ship at `pos`, with leg `active`
  // running from waypoints[active - 1] to waypoints[active].
  // Returns { active, toNextNm, bearingToNext, xteNm, dtgNm, arrived }.
  function routeProgress(waypoints, pos, active, arrivalNm = 0.25) {
    let leg = Math.max(1, Math.min(active, waypoints.length - 1));
    let arrived = false;
    for (;;) {
      const from = waypoints[leg - 1];
      const to = waypoints[leg];
      const [bx, by] = toLocal(from, to);
      const [px, py] = toLocal(from, pos);
      const len = Math.hypot(bx, by) || 1e-9;
      const along = (px * bx + py * by) / len;
      const toNext = rhumb(pos, to).distanceNm;
      // Waypoint reached: close enough, or the ship has passed abeam of it.
      if (toNext <= arrivalNm || along >= len) {
        if (leg === waypoints.length - 1) {
          arrived = toNext <= Math.max(arrivalNm, 1);
          break;
        }
        leg++;
        continue;
      }
      break;
    }
    const from = waypoints[leg - 1];
    const to = waypoints[leg];
    const [bx, by] = toLocal(from, to);
    const [px, py] = toLocal(from, pos);
    const len = Math.hypot(bx, by) || 1e-9;
    const xteNm = (px * by - py * bx) / len; // > 0: ship is to the right (starboard) of the track
    const next = rhumb(pos, to);
    let dtg = next.distanceNm;
    for (let i = leg + 1; i < waypoints.length; i++) dtg += rhumb(waypoints[i - 1], waypoints[i]).distanceNm;
    return { active: leg, toNextNm: next.distanceNm, bearingToNext: next.bearing, xteNm, dtgNm: dtg, arrived };
  }

  // Rolling average of speed over ground (knots) for steady ETAs.
  class SpeedAverage {
    constructor(windowMs = 10 * 60 * 1000) {
      this.windowMs = windowMs;
      this.samples = [];
    }
    add(sog, t = Date.now()) {
      if (sog == null || !Number.isFinite(sog)) return;
      this.samples.push([t, sog]);
      while (this.samples.length && this.samples[0][0] < t - this.windowMs) this.samples.shift();
    }
    get value() {
      if (!this.samples.length) return null;
      return this.samples.reduce((s, x) => s + x[1], 0) / this.samples.length;
    }
  }

  function formatDuration(hours) {
    if (!Number.isFinite(hours) || hours < 0) return '—';
    const totalMin = Math.round(hours * 60);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d) return `${d}d ${String(h).padStart(2, '0')}h`;
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }

  const api = {
    rhumb, greatCircleNm, pathLengthNm, unwrapPath, wrapLon, SeaRouter, routeProgress, SpeedAverage, formatDuration,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NavCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
