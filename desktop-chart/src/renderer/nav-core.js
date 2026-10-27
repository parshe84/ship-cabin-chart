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

  // --- Collision avoidance: closest point of approach ---

  // own/target: { lat, lon, sog (kn), cog (deg) }. Returns { cpaNm, tcpaMin, rangeNm, bearing }.
  // tcpaMin < 0 means the closest point is already behind (the vessels are opening).
  function cpa(own, target) {
    const toXY = (p) => toLocal([own.lat, own.lon], [p.lat, p.lon]);
    const vel = (v) => {
      const s = v.sog || 0, c = (v.cog || 0) * rad;
      return [s * Math.sin(c), s * Math.cos(c)]; // knots east, north
    };
    const [px, py] = toXY(target);
    const [ox, oy] = vel(own);
    const [tx, ty] = vel(target);
    const dvx = tx - ox, dvy = ty - oy;
    const dv2 = dvx * dvx + dvy * dvy;
    const tcpaH = dv2 < 1e-9 ? 0 : -(px * dvx + py * dvy) / dv2;
    const cx = px + dvx * tcpaH, cy = py + dvy * tcpaH;
    return {
      cpaNm: Math.hypot(cx, cy),
      tcpaMin: tcpaH * 60,
      rangeNm: Math.hypot(px, py),
      bearing: (Math.atan2(px, py) / rad + 360) % 360,
    };
  }

  // --- Barometer ---

  // samples: [[timeMs, hPa]] in time order. Change over the last 1 h and 3 h, and an alert level
  // by the classic rule of thumb: a fall of 3 hPa or more in 3 hours means a gale is likely.
  function pressureTrend(samples, now = Date.now()) {
    if (!samples.length) return null;
    const latest = samples[samples.length - 1];
    const at = (msAgo) => {
      const t = now - msAgo;
      let best = null;
      for (const s of samples) {
        if (s[0] < t - 20 * 60 * 1000) continue; // need a sample within 20 min of the target time
        if (s[0] > t + 20 * 60 * 1000) break;
        if (!best || Math.abs(s[0] - t) < Math.abs(best[0] - t)) best = s;
      }
      return best;
    };
    const h1 = at(3600e3), h3 = at(3 * 3600e3);
    const change1h = h1 ? latest[1] - h1[1] : null;
    const change3h = h3 ? latest[1] - h3[1] : null;
    let alert = null;
    if (change3h != null && change3h <= -6) alert = 'severe';
    else if ((change3h != null && change3h <= -3) || (change1h != null && change1h <= -2)) alert = 'storm';
    return { hPa: latest[1], change1h, change3h, alert };
  }

  // --- Phone compass calibration ---

  // The phone on the porthole doesn't point at the bow. While the ship makes way on a steady
  // course, the difference between COG and the phone's heading is that mounting offset.
  class HeadingCalibration {
    constructor(offset = null) {
      this.offset = offset;
      this.samples = [];
    }
    add(cog, phoneHeading, sog) {
      if (cog == null || phoneHeading == null || sog == null || sog < 4) return;
      this.samples.push(wrapLon(cog - phoneHeading));
      if (this.samples.length > 120) this.samples.shift();
      if (this.samples.length < 30) return;
      // Circular mean and spread of the differences.
      let x = 0, y = 0;
      for (const d of this.samples) {
        x += Math.cos(d * rad);
        y += Math.sin(d * rad);
      }
      const r = Math.hypot(x, y) / this.samples.length;
      if (r > 0.97) this.offset = Math.atan2(y, x) / rad; // spread under ~14°
    }
    heading(phoneHeading) {
      if (phoneHeading == null || this.offset == null) return null;
      return ((phoneHeading + this.offset) % 360 + 360) % 360;
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
    pressureTrend, HeadingCalibration, cpa,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NavCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
