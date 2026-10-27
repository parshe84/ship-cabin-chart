'use strict';

// Voyage tools on the chart:
//  - RoutePlanner: plot a route from the ship's GPS position with the mouse (click = waypoint,
//    Shift+click = follow sea lanes), drag/insert/delete waypoints, then follow it live with
//    distance to go, ETA, next waypoint and cross-track error.
//  - MeasureTool: quick ruler between any points.
//  - GridLabels: latitude/longitude labels along the chart edges.
//  - Distances dialog: world port-to-port sea distances (table + any two of ~4,000 ports).

(function () {
  const { rhumb, pathLengthNm, routeProgress, formatDuration, unwrapPath, wrapLon } = NavCore;

  const fmtNm = (nm) => (nm >= 100 ? Math.round(nm).toLocaleString('en-US') : nm.toFixed(1));
  const fmtBrg = (b) => `${String(Math.round(b) % 360).padStart(3, '0')}°`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function fmtEta(hours) {
    if (!Number.isFinite(hours) || hours < 0) return { at: '—', in: '' };
    const t = new Date(Date.now() + hours * 3600 * 1000);
    const day = t.toLocaleString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    return { at: `${day} ${t.toISOString().slice(11, 16)} UTC`, in: formatDuration(hours) };
  }

  const PASSAGE_NAMES = {
    suez: 'Suez Canal', panama: 'Panama Canal', malacca: 'Strait of Malacca', gibraltar: 'Gibraltar',
    babalmandab: 'Bab-el-Mandeb', ormuz: 'Strait of Hormuz', bosporus: 'Bosporus', dardanelles: 'Dardanelles',
    sunda: 'Sunda Strait', south_africa: 'Cape of Good Hope', chili: 'Cape Horn / Magellan',
    bering: 'Bering Strait', northwest: 'Northwest Passage',
  };

  // ---------------------------------------------------------------------------
  // Lat/lon grid labels along the chart edges
  // ---------------------------------------------------------------------------

  function gridStep(z) {
    if (z <= 2) return 30;
    if (z <= 4) return 10;
    if (z <= 6) return 5;
    if (z <= 8) return 1;
    if (z <= 10) return 0.25;
    if (z <= 12) return 1 / 12;
    return 1 / 60;
  }

  function fmtGrid(v, pos, neg, step) {
    const hemi = v > 0 ? pos : v < 0 ? neg : '';
    const a = Math.abs(v);
    const d = Math.floor(a + 1e-9);
    const m = Math.round((a - d) * 60);
    return step < 1 ? `${d}°${String(m).padStart(2, '0')}′${hemi}` : `${d}°${hemi}`;
  }

  const GridLabels = L.Layer.extend({
    onAdd(map) {
      this._el = L.DomUtil.create('div', 'grid-labels', map.getContainer());
      this._update = () => {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
          this._raf = null;
          this._render();
        });
      };
      map.on('move zoom resize', this._update);
      this._render();
    },
    onRemove(map) {
      map.off('move zoom resize', this._update);
      this._el.remove();
    },
    _render() {
      const map = this._map;
      const size = map.getSize();
      const b = map.getBounds();
      const step = gridStep(map.getZoom());
      let html = '';
      for (let lat = Math.ceil(b.getSouth() / step) * step; lat <= b.getNorth(); lat += step) {
        const y = map.latLngToContainerPoint([lat, b.getWest()]).y;
        if (y < 14 || y > size.y - 14) continue;
        html += `<span class="gl lat" style="top:${y}px">${fmtGrid(lat, 'N', 'S', step)}</span>`;
      }
      for (let lon = Math.ceil(b.getWest() / step) * step; lon <= b.getEast(); lon += step) {
        const x = map.latLngToContainerPoint([b.getNorth(), lon]).x;
        if (x < 30 || x > size.x - 30) continue;
        html += `<span class="gl lon" style="left:${x}px">${fmtGrid(wrapLon(lon), 'E', 'W', step)}</span>`;
      }
      this._el.innerHTML = html;
    },
  });

  // ---------------------------------------------------------------------------
  // Shared drawing helpers
  // ---------------------------------------------------------------------------

  function legLabel(a, b) {
    const r = rhumb(a, b);
    return `${fmtBrg(r.bearing)} · ${fmtNm(r.distanceNm)} nm`;
  }

  function midpoint(a, b) {
    return [(a[0] + b[0]) / 2, a[1] + wrapLon(b[1] - a[1]) / 2];
  }

  // ---------------------------------------------------------------------------
  // Measure tool
  // ---------------------------------------------------------------------------

  class MeasureTool {
    constructor(map, onExit) {
      this.map = map;
      this.onExit = onExit;
      this.layer = L.layerGroup().addTo(map);
      this.points = [];
      this.active = false;
    }

    start() {
      this.active = true;
      this.clear();
      this.map.getContainer().classList.add('measuring');
      this.map.doubleClickZoom.disable();
      this._click = (e) => this.add([e.latlng.lat, e.latlng.lng]);
      this._move = (e) => this._preview([e.latlng.lat, e.latlng.lng]);
      this._key = (e) => { if (e.key === 'Escape') this.stop(); };
      this.map.on('click', this._click).on('mousemove', this._move);
      document.addEventListener('keydown', this._key);
    }

    stop() {
      if (!this.active) return;
      this.active = false;
      this.map.getContainer().classList.remove('measuring');
      this.map.doubleClickZoom.enable();
      this.map.off('click', this._click).off('mousemove', this._move);
      document.removeEventListener('keydown', this._key);
      this.clear();
      this.onExit && this.onExit();
    }

    clear() {
      this.points = [];
      this.layer.clearLayers();
      this.line = L.polyline([], { className: 'measure-line', weight: 2, interactive: false }).addTo(this.layer);
      this.rubber = L.polyline([], { className: 'measure-line rubber', weight: 2, interactive: false }).addTo(this.layer);
      this.tip = L.tooltip({ permanent: true, direction: 'auto', offset: [14, 0], className: 'nav-tip' });
    }

    add(p) {
      if (this.points.length) {
        const prev = this.points[this.points.length - 1];
        p = [p[0], prev[1] + wrapLon(p[1] - prev[1])];
        L.marker(midpoint(prev, p), {
          icon: L.divIcon({ className: 'leg-label', html: `<span>${legLabel(prev, p)}</span>`, iconSize: [0, 0] }),
          interactive: false,
        }).addTo(this.layer);
      }
      this.points.push(p);
      L.circleMarker(p, { radius: 4, className: 'measure-dot', interactive: false }).addTo(this.layer);
      this.line.setLatLngs(this.points);
    }

    _preview(p) {
      if (!this.points.length) return;
      const last = this.points[this.points.length - 1];
      p = [p[0], last[1] + wrapLon(p[1] - last[1])];
      this.rubber.setLatLngs([last, p]);
      const total = pathLengthNm(this.points) + rhumb(last, p).distanceNm;
      this.tip.setLatLng(p).setContent(
        `<b>${legLabel(last, p)}</b><br>Total ${fmtNm(total)} nm · ${(total * 1.852).toFixed(total > 50 ? 0 : 1)} km`,
      );
      if (!this.map.hasLayer(this.tip)) this.tip.addTo(this.layer);
    }
  }

  // ---------------------------------------------------------------------------
  // Route planner + live voyage
  // ---------------------------------------------------------------------------

  class RoutePlanner {
    // opts: { map, router(), getShip() -> {lat, lon} | null, getSpeed() -> knots | null,
    //         save(route), onChange() }
    constructor(opts) {
      Object.assign(this, opts);
      this.layer = L.layerGroup().addTo(this.map);
      this.route = null; // { waypoints: [{lat, lon, auto}], active, avoid: [] }
      this.planning = false;
      this.progress = null;
      this.avoid = ['northwest'];
    }

    // --- persistence ---

    load(saved) {
      if (saved && Array.isArray(saved.waypoints) && saved.waypoints.length >= 2) {
        this.route = { waypoints: saved.waypoints, active: saved.active || 1 };
        if (Array.isArray(saved.avoid)) this.avoid = saved.avoid;
        this.redraw();
        this.update();
      }
    }

    persist() {
      this.save(this.route ? { ...this.route, avoid: this.avoid } : null);
    }

    points() {
      return this.route ? this.route.waypoints.map((w) => [w.lat, w.lon]) : [];
    }

    // --- planning mode ---

    startPlanning() {
      if (this.planning) return;
      if (!this.route) {
        const ship = this.getShip();
        const start = ship ? [ship.lat, ship.lon] : [this.map.getCenter().lat, this.map.getCenter().lng];
        this.route = { waypoints: [{ lat: start[0], lon: start[1], start: true }], active: 1 };
        this.startNote = ship ? 'from ship' : 'from chart centre (no GPS yet)';
      }
      this.planning = true;
      const m = this.map;
      m.getContainer().classList.add('planning');
      m.doubleClickZoom.disable();
      this._click = (e) => this._onClick(e);
      this._move = (e) => this._onMove(e);
      this._dbl = () => {
        // The two clicks of a double-click each added a waypoint: keep only the first.
        const wps = this.route.waypoints;
        if (wps.length >= 3) {
          const a = this.map.latLngToContainerPoint([wps[wps.length - 1].lat, wps[wps.length - 1].lon]);
          const b = this.map.latLngToContainerPoint([wps[wps.length - 2].lat, wps[wps.length - 2].lon]);
          if (a.distanceTo(b) < 8) wps.pop();
        }
        this.finishPlanning();
      };
      this._key = (e) => this._onKey(e);
      m.on('click', this._click).on('mousemove', this._move).on('dblclick', this._dbl);
      document.addEventListener('keydown', this._key);
      document.addEventListener('keyup', this._key);
      this.rubber = L.polyline([], { className: 'route-rubber', weight: 2, interactive: false }).addTo(this.layer);
      this.tip = L.tooltip({ permanent: true, direction: 'auto', offset: [16, 0], className: 'nav-tip' });
      this.redraw();
      this.onChange();
    }

    finishPlanning() {
      if (!this.planning) return;
      this.planning = false;
      const m = this.map;
      m.getContainer().classList.remove('planning');
      m.doubleClickZoom.enable();
      m.off('click', this._click).off('mousemove', this._move).off('dblclick', this._dbl);
      document.removeEventListener('keydown', this._key);
      document.removeEventListener('keyup', this._key);
      if (this.route && this.route.waypoints.length < 2) this.route = null;
      this.redraw();
      this.update();
      this.persist();
      this.onChange();
    }

    clear() {
      const wasPlanning = this.planning;
      if (wasPlanning) this.finishPlanning();
      this.route = null;
      this.progress = null;
      this.redraw();
      this.persist();
      this.onChange();
      if (wasPlanning) this.startPlanning();
    }

    undo() {
      if (!this.route || this.route.waypoints.length <= 1) return;
      const wps = this.route.waypoints;
      // Remove the last user waypoint together with the sea-lane points leading to it.
      wps.pop();
      while (wps.length > 1 && wps[wps.length - 1].auto) wps.pop();
      this.redraw();
      this.update();
      this.onChange();
    }

    _lastPoint() {
      const w = this.route.waypoints[this.route.waypoints.length - 1];
      return [w.lat, w.lon];
    }

    _seaPath(from, to) {
      const router = this.router();
      if (!router) return null;
      return router.route(from, [to[0], from[1] + wrapLon(to[1] - from[1])], this.avoid);
    }

    _onClick(e) {
      const p = [e.latlng.lat, e.latlng.lng];
      const last = this._lastPoint();
      const target = [p[0], last[1] + wrapLon(p[1] - last[1])];
      if (e.originalEvent.shiftKey) {
        const sea = this._seaPath(last, target);
        if (sea) {
          const pts = sea.points.slice(1);
          // Keep the unwrapped longitudes continuous from the last waypoint.
          let prevLon = last[1];
          pts.forEach(([lat, lon], i) => {
            const l = prevLon + wrapLon(lon - prevLon);
            prevLon = l;
            this.route.waypoints.push({ lat, lon: l, auto: i < pts.length - 1 });
          });
        }
      } else {
        this.route.waypoints.push({ lat: target[0], lon: target[1] });
      }
      this.redraw();
      this.update();
      this.onChange();
    }

    _onMove(e) {
      this._lastMouse = e;
      const p = [e.latlng.lat, e.latlng.lng];
      const last = this._lastPoint();
      const target = [p[0], last[1] + wrapLon(p[1] - last[1])];
      const shift = e.originalEvent && e.originalEvent.shiftKey;
      let path = [last, target];
      let leg = rhumb(last, target).distanceNm;
      let via = '';
      if (shift) {
        const sea = this._seaPath(last, target);
        if (sea) {
          path = sea.points;
          leg = sea.distanceNm;
          via = sea.passages.length ? `via ${sea.passages.map((x) => PASSAGE_NAMES[x] || x).join(', ')}` : 'sea lanes';
        }
      }
      this.rubber.setLatLngs(path);
      this.rubber.getElement() && this.rubber.getElement().classList.toggle('sea', !!shift);
      const total = pathLengthNm(this.points()) + leg;
      const speed = this.getSpeed();
      const eta = speed ? fmtEta(total / speed) : null;
      const head = shift ? `<b>Sea route ${fmtNm(leg)} nm</b><br><small>${esc(via)}</small>` :
        `<b>${legLabel(last, target)}</b>`;
      this.tip.setLatLng(target).setContent(
        `${head}<br>Total <b>${fmtNm(total)} nm</b>` +
        (eta ? `<br>ETA ${eta.at} <small>(${eta.in} @ ${speed.toFixed(1)} kn)</small>` : '<br><small>ETA needs a speed</small>'),
      );
      if (!this.map.hasLayer(this.tip)) this.tip.addTo(this.layer);
    }

    _onKey(e) {
      if (e.type === 'keydown') {
        if (e.key === 'Escape' || e.key === 'Enter') this.finishPlanning();
        else if (e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) this.undo();
      }
      // Re-run the preview so holding/releasing Shift switches straight vs sea-lane instantly.
      if (e.key === 'Shift' && this._lastMouse) {
        this._lastMouse.originalEvent = { shiftKey: e.type === 'keydown' };
        this._onMove(this._lastMouse);
      }
    }

    // --- drawing ---

    redraw() {
      const rubber = this.rubber;
      const tip = this.tip;
      this.layer.clearLayers();
      if (this.planning) {
        rubber && rubber.addTo(this.layer);
        tip && this.map.hasLayer(tip) && tip.addTo(this.layer);
      }
      if (!this.route) return;
      const wps = this.route.waypoints;
      const pts = this.points();
      const active = this.progress ? this.progress.active : this.route.active || 1;

      if (pts.length >= 2) {
        L.polyline(pts.slice(0, active), { className: 'route-line done', weight: 3, interactive: false }).addTo(this.layer);
        const ahead = L.polyline(pts.slice(active - 1), { className: 'route-line', weight: 3.5, bubblingMouseEvents: false })
          .addTo(this.layer);
        // Click on the route line while planning inserts a waypoint into that leg.
        ahead.on('click', (e) => {
          if (!this.planning) return;
          L.DomEvent.stop(e);
          this._insertAt([e.latlng.lat, e.latlng.lng]);
        });
      }

      // Leg labels on user legs (between non-auto waypoints) that are long enough on screen.
      let segStart = 0;
      for (let i = 1; i < wps.length; i++) {
        if (wps[i].auto) continue;
        const seg = pts.slice(segStart, i + 1);
        const a = this.map.latLngToContainerPoint(seg[0]);
        const b = this.map.latLngToContainerPoint(seg[seg.length - 1]);
        if (a.distanceTo(b) > 130) {
          const dist = pathLengthNm(seg);
          const text = seg.length === 2 ? legLabel(seg[0], seg[1]) : `sea route · ${fmtNm(dist)} nm`;
          L.marker(seg.length === 2 ? midpoint(seg[0], seg[1]) : seg[Math.floor(seg.length / 2)], {
            icon: L.divIcon({ className: 'leg-label route', html: `<span>${text}</span>`, iconSize: [0, 0] }),
            interactive: false,
          }).addTo(this.layer);
        }
        segStart = i;
      }

      // Waypoint markers: numbered for user waypoints, small dots for sea-lane points.
      let n = 0;
      wps.forEach((w, i) => {
        if (i === 0) {
          L.circleMarker(pts[0], { radius: 5, className: 'route-start', interactive: false }).addTo(this.layer);
          return;
        }
        const user = !w.auto;
        if (user) n++;
        const isNext = i === active;
        const icon = L.divIcon({
          className: `wp ${user ? 'user' : 'auto'} ${i < active ? 'passed' : ''} ${isNext ? 'next' : ''}`,
          html: user ? `<b>${i === wps.length - 1 ? '⚑' : n}</b>` : '',
          iconSize: user ? [24, 24] : [8, 8],
          iconAnchor: user ? [12, 12] : [4, 4],
        });
        const marker = L.marker(pts[i], { icon, draggable: this.planning, keyboard: false, zIndexOffset: user ? 500 : 0 });
        marker.on('drag', (e) => {
          const ll = e.target.getLatLng();
          wps[i].lat = ll.lat;
          wps[i].lon = ll.lng;
          wps[i].auto = false;
        });
        marker.on('dragend', () => { this.redraw(); this.update(); this.onChange(); });
        marker.on('contextmenu', (e) => {
          L.DomEvent.stop(e);
          if (!this.planning) return;
          wps.splice(i, 1);
          this.redraw();
          this.update();
          this.onChange();
        });
        marker.addTo(this.layer);
      });
    }

    _insertAt(p) {
      const pts = this.points();
      let best = 1, bestD = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const a = this.map.latLngToLayerPoint(pts[i - 1]);
        const b = this.map.latLngToLayerPoint(pts[i]);
        const q = this.map.latLngToLayerPoint(p);
        const d = L.LineUtil.pointToSegmentDistance(q, a, b);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      this.route.waypoints.splice(best, 0, { lat: p[0], lon: p[1] });
      this.redraw();
      this.update();
      this.onChange();
    }

    // --- following the route ---

    update() {
      if (!this.route || this.route.waypoints.length < 2) {
        this.progress = null;
        return;
      }
      const ship = this.getShip();
      const pts = this.points();
      if (!ship) {
        this.progress = { active: this.route.active, dtgNm: pathLengthNm(pts), toNextNm: null, xteNm: null };
        return;
      }
      const prevActive = this.progress ? this.progress.active : this.route.active;
      // Ship longitude near the route's (unwrapped) longitudes.
      const ref = pts[Math.min(prevActive, pts.length - 1)][1];
      const pos = [ship.lat, ref + wrapLon(ship.lon - ref)];
      this.progress = routeProgress(pts, pos, prevActive);
      if (this.progress.active !== prevActive) {
        this.route.active = this.progress.active;
        this.persist();
        this.redraw();
      }
    }

    summary() {
      if (!this.route || this.route.waypoints.length < 2 || !this.progress) return null;
      const wps = this.route.waypoints;
      const speed = this.getSpeed();
      const p = this.progress;
      // Number of the next user waypoint (sea-lane points are not numbered).
      let n = 0, nextUser = null;
      for (let i = 1; i < wps.length; i++) {
        if (!wps[i].auto) n++;
        if (i >= p.active && !wps[i].auto) {
          nextUser = i === wps.length - 1 ? '⚑' : String(n);
          break;
        }
      }
      return {
        dtg: p.dtgNm,
        eta: speed ? fmtEta(p.dtgNm / speed) : null,
        speed,
        next: nextUser,
        toNext: p.toNextNm,
        brgNext: p.bearingToNext,
        xte: p.xteNm,
        arrived: p.arrived,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Distances dialog: table of major ports + any port to any port
  // ---------------------------------------------------------------------------

  function setupDistances({ dialog, router, table, getShip, getSpeed, showRoute, useRoute, avoidRef }) {
    const ports = router().ports; // [name, locode, country, lon, lat, node, snap]
    const byCode = new Map(ports.map((p) => [p[1], p]));
    const label = (p) => `${p[0]} — ${p[2]} (${p[1]})`;

    dialog.querySelector('#ports-list').innerHTML =
      '<option value="Ship position"></option>' + ports.map((p) => `<option value="${esc(label(p))}"></option>`).join('');

    const passages = router().passages.filter((x) => x !== 'bering');
    dialog.querySelector('#avoid-list').innerHTML = passages
      .map((x) => `<label class="chip"><input type="checkbox" value="${x}" ${avoidRef().includes(x) ? 'checked' : ''}> ${PASSAGE_NAMES[x] || x}</label>`)
      .join('');

    const readPoint = (value) => {
      if (/^ship/i.test(value.trim())) {
        const s = getShip();
        return s ? { name: 'Ship', at: [s.lat, s.lon] } : null;
      }
      const code = (value.match(/\(([A-Z]{5})\)\s*$/) || [])[1];
      const p = code && byCode.get(code);
      return p ? { name: p[0], at: [p[4], p[3]], snap: p[6] } : null;
    };

    let lastResult = null;
    const out = dialog.querySelector('#p2p-result');
    const calc = () => {
      const from = readPoint(dialog.querySelector('#p2p-from').value);
      const to = readPoint(dialog.querySelector('#p2p-to').value);
      const avoid = [...dialog.querySelectorAll('#avoid-list input:checked')].map((i) => i.value);
      avoidRef(avoid);
      if (!from || !to) {
        out.innerHTML = '<span class="muted">Pick two ports from the list (type to search) or "Ship position".</span>';
        lastResult = null;
        return;
      }
      const r = router().route(from.at, to.at, avoid);
      if (!r) {
        out.innerHTML = '<span class="muted">No sea route found with these restrictions.</span>';
        lastResult = null;
        return;
      }
      lastResult = { ...r, from, to };
      const speed = getSpeed() || 12;
      const via = r.passages.filter((x) => x !== 'segment').map((x) => PASSAGE_NAMES[x] || x);
      const far = Math.max(from.snap || 0, to.snap || 0) > 30;
      out.innerHTML = `
        <div class="p2p-big"><b>${fmtNm(r.distanceNm)}</b> nm <small>${Math.round(r.distanceNm * 1.852).toLocaleString('en-US')} km</small></div>
        <div>${esc(from.name)} → ${esc(to.name)}${via.length ? ` · via ${esc(via.join(', '))}` : ''}</div>
        <div class="muted">${formatDuration(r.distanceNm / speed)} at ${speed.toFixed(1)} kn${far ? ' · port is far from the shipping-lane network, distance is approximate' : ''}</div>`;
    };
    dialog.querySelectorAll('#p2p-from, #p2p-to').forEach((i) => i.addEventListener('change', calc));
    dialog.querySelector('#avoid-list').addEventListener('change', calc);
    dialog.querySelector('#p2p-show').onclick = () => {
      if (!lastResult) return;
      showRoute(lastResult);
      dialog.close();
    };
    dialog.querySelector('#p2p-use').onclick = () => {
      if (!lastResult) return;
      useRoute(lastResult);
      dialog.close();
    };

    // Table
    const t = table;
    const head = t.ports.map((p, j) => `<th data-c="${j}" title="${esc(p[0])}, ${esc(p[2])}"><span>${esc(p[0])}</span></th>`).join('');
    const rows = t.ports.map((p, i) => `<tr><th data-r="${i}">${esc(p[0])} <small>${p[1].slice(0, 2)}</small></th>` +
      t.nm[i].map((v, j) => `<td data-r="${i}" data-c="${j}">${i === j ? '' : v.toLocaleString('en-US')}</td>`).join('') + '</tr>').join('');
    const tableEl = dialog.querySelector('#dist-table');
    tableEl.innerHTML = `<thead><tr><th class="corner">nm</th>${head}</tr></thead><tbody>${rows}</tbody>`;
    tableEl.addEventListener('mouseover', (e) => {
      const td = e.target.closest('td');
      tableEl.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
      if (!td) return;
      const { r, c } = td.dataset;
      tableEl.querySelectorAll(`[data-r="${r}"], [data-c="${c}"]`).forEach((x) => x.classList.add('hl'));
    });
    tableEl.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (!td || td.dataset.r === td.dataset.c) return;
      const a = t.ports[+td.dataset.r], b = t.ports[+td.dataset.c];
      dialog.querySelector('#p2p-from').value = label(byCode.get(a[1]));
      dialog.querySelector('#p2p-to').value = label(byCode.get(b[1]));
      switchTab('p2p');
      calc();
    });

    const switchTab = (name) => {
      dialog.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
      dialog.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('on', p.id === `tab-${name}`));
    };
    dialog.querySelectorAll('.tab').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
    calc();
  }

  window.Voyage = { GridLabels, MeasureTool, RoutePlanner, setupDistances, fmtNm, fmtBrg, fmtEta, PASSAGE_NAMES, unwrapPath };
})();
