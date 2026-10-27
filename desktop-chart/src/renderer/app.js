'use strict';

const $ = (id) => document.getElementById(id);

const map = L.map('map', { zoomControl: true, worldCopyJump: true, maxZoom: 18 }).setView([30, 0], 3);
map.zoomControl.setPosition('topleft');

// Built-in offline world chart: always available, no internet needed.
const world = WorldChart.createWorldChart(map, window.ship.loadWorldLayer, {
  onPortClick: (port, marker) => showPortPopup(port, marker),
});
world.chart.addTo(map);
world.labels.addTo(map);
world.ready
  .then(() => {
    $('status-map').textContent = 'World chart · offline · built in';
    depthLegend.render(world.legend());
    render();
  })
  .catch((err) => { $('status-map').textContent = `World chart failed: ${err.message}`; });

// Detailed coastal maps on top when zoomed in: online, or from the download cache.
// Missing tiles are transparent, so the world chart shows through.
const osm = L.tileLayer('tilecache://osm/{z}/{x}/{y}.png', {
  minZoom: 9,
  maxZoom: 18,
  className: 'osm-tiles',
  attribution: '© OpenStreetMap contributors',
}).addTo(map);
const seamarks = L.tileLayer('tilecache://seamark/{z}/{x}/{y}.png', {
  minZoom: 9,
  maxZoom: 18,
  className: 'seamark-tiles',
  attribution: '© OpenSeaMap',
}).addTo(map);
// Latitude/longitude grid: lines are drawn in the chart tiles, labels along the edges.
const gridLabels = new Voyage.GridLabels().addTo(map);
// AIS targets (if the ship's AIS feed reaches this computer over UDP/TCP).
const aisLayer = new AisLayer(map, () => ownForCpa(), (t, d) => {
  showAlert(`AIS: ${t.name || `MMSI ${t.mmsi}`} will pass ${d.cpaNm.toFixed(2)} nm in ${Math.round(d.tcpaMin)} min`);
});
aisLayer.group.addTo(map);
// Toggles for the OSM maritime layer drawn inside the chart tiles.
const tssToggle = L.layerGroup().addTo(map);
const limitsToggle = L.layerGroup().addTo(map);
L.control.layers(null, {
  'Lat / lon grid': gridLabels,
  'AIS targets': aisLayer.group,
  '<span class="lc-tss">▰</span> Traffic separation schemes': tssToggle,
  '<span class="lc-lim">┅</span> Maritime limits: 12 nm · 24 nm · EEZ': limitsToggle,
  'Place names, ports': world.labels,
  'OpenStreetMap detail (zoom 9+)': osm,
  'Seamarks (zoom 9+)': seamarks,
}, { position: 'topleft' }).addTo(map);
map.on('overlayadd overlayremove', (e) => {
  const on = e.type === 'overlayadd';
  if (e.layer === tssToggle) {
    world.setVisible('tss', on);
    window.ship.saveSettings({ tss: on });
  }
  if (e.layer === limitsToggle) {
    world.setVisible('limits', on);
    window.ship.saveSettings({ limits: on });
  }
  if (e.layer === gridLabels) {
    world.setGraticule(e.type === 'overlayadd');
    window.ship.saveSettings({ grid: e.type === 'overlayadd' });
  }
});
L.control.scale({ metric: true, imperial: true, position: 'bottomleft' }).addTo(map);

// --- Depth legend with a readout of the chart depth under the cursor ---

function formatDepth(d) {
  if (!d) return { value: '—', unit: '' };
  if (d.land) return { value: 'Land', unit: '' };
  if (d.to == null) return { value: `>${d.from.toLocaleString('en-US')}`, unit: 'm' };
  return { value: `${d.from.toLocaleString('en-US')}–${d.to.toLocaleString('en-US')}`, unit: 'm' };
}

const LEGEND_TICKS = [0, 10, 50, 200, 1000, 4000, 10000];
const DepthLegend = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const div = L.DomUtil.create('div', 'depth-legend');
    div.innerHTML = '<div class="title"><span>Depth, m</span><span>ETOPO1 · general chart</span></div>' +
      '<div class="swatches"></div><div class="ticks"></div><div class="cursor"></div>';
    L.DomEvent.disableClickPropagation(div);
    return div;
  },
  render(legend) {
    const el = this.getContainer();
    el.querySelector('.swatches').innerHTML = legend.map((l) => `<span style="background:${l.color}"></span>`).join('');
    const n = legend.length;
    el.querySelector('.ticks').innerHTML = LEGEND_TICKS
      .map((d) => `<span style="left:${((legend.findIndex((l) => l.depth === d) + 0.5) / n) * 100}%">${d >= 1000 ? d / 1000 + 'k' : d}</span>`)
      .join('');
    // Same ramp for the HUD depth bar.
    document.body.style.setProperty('--depth-gradient',
      `linear-gradient(90deg, ${legend.map((l, i) => `${l.color} ${(i / (n - 1)) * 100}%`).join(', ')})`);
  },
  setCursor(html) {
    this.getContainer().querySelector('.cursor').innerHTML = html;
  },
});
const depthLegend = new DepthLegend().addTo(map);

let cursorTimer = null;
map.on('mousemove', (e) => {
  if (cursorTimer) return;
  cursorTimer = setTimeout(() => {
    cursorTimer = null;
    const { lat, lng } = e.latlng.wrap();
    const d = formatDepth(world.depthAt(lat, lng));
    depthLegend.setCursor(`<b>${d.value}</b> ${d.unit} · ${toDdm(lat, 'N', 'S')} ${toDdm(lng, 'E', 'W')}`);
  }, 60);
});
map.on('mouseout', () => depthLegend.setCursor(''));

// --- Ship marker & track ---

const SHIP_SIZE = 44;
const shipIcon = L.divIcon({
  className: 'ship-marker',
  iconSize: [SHIP_SIZE, SHIP_SIZE],
  iconAnchor: [SHIP_SIZE / 2, SHIP_SIZE / 2],
  html: `
    <div class="ring"></div>
    <svg width="${SHIP_SIZE}" height="${SHIP_SIZE}" viewBox="-22 -22 44 44">
      <defs>
        <linearGradient id="hull" x1="0" y1="-1" x2="0" y2="1">
          <stop offset="0" stop-color="var(--ship)"/>
          <stop offset="1" stop-color="var(--ship-2)"/>
        </linearGradient>
      </defs>
      <path d="M0,-19 L11,14 L0,7 L-11,14 Z" fill="url(#hull)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`,
});
let shipMarker = null;
const trackLine = L.polyline([], { className: 'track-line', weight: 3, opacity: 0.95, lineCap: 'round' }).addTo(map);

const state = { lat: null, lon: null, sog: null, cog: null, satellites: null, time: null, lastFix: 0, follow: true };
let track = []; // [lat, lon, timeMs]
let trackDirty = false;
let loggedMeters = 0;

function toDdm(value, pos, neg) {
  if (value == null) return '—';
  const hemi = value >= 0 ? pos : neg;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${String(deg).padStart(pos === 'E' ? 3 : 2, '0')}° ${min.toFixed(3).padStart(6, '0')}′ ${hemi}`;
}

function distanceMeters(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad, dLon = (b[1] - a[1]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function recomputeLogged() {
  loggedMeters = 0;
  for (let i = 1; i < track.length; i++) loggedMeters += distanceMeters(track[i - 1], track[i]);
}

function addTrackPoint(lat, lon, time) {
  const p = [lat, lon, time || Date.now()];
  const last = track[track.length - 1];
  if (last) {
    const d = distanceMeters(last, p);
    if (d < 15) return;
    loggedMeters += d;
  }
  track.push(p);
  if (track.length > 50000) track.shift();
  trackLine.addLatLng([lat, lon]);
  trackDirty = true;
}

function setNeedle(cog, hdg) {
  const angle = cog || 0;
  $('needle').style.transform = `rotate(${angle}deg)`;
  const hn = $('hdg-needle');
  hn.style.opacity = hdg != null ? 1 : 0;
  if (hdg != null) hn.style.transform = `rotate(${hdg}deg)`;
  $('hdg-readout').textContent = hdg != null
    ? `HDG ${String(Math.round(hdg) % 360).padStart(3, '0')}° · compass`
    : state.phoneHdg != null ? 'HDG: calibrating (needs > 4 kn)' : '';
  // Stopped or drifting: COG is meaningless, show the ship's heading from the compass instead.
  const shipAngle = hdg != null && (state.sog == null || state.sog < 1) ? hdg : angle;
  if (shipMarker) {
    const svg = shipMarker.getElement()?.querySelector('svg');
    if (svg) svg.style.transform = `rotate(${shipAngle}deg)`;
  }
}

function renderDepth() {
  const d = state.lat != null ? world.depthAt(state.lat, state.lon) : null;
  const f = formatDepth(d);
  $('depth').textContent = f.value;
  $('depth-unit').textContent = f.unit;
  const marker = $('depth-bar').querySelector('i');
  if (d && !d.land) {
    const levels = WorldChart.DEPTH_LEVELS;
    const i = levels.indexOf(d.from);
    marker.style.left = `${((i + 0.5) / levels.length) * 100}%`;
    marker.style.opacity = 1;
  } else {
    marker.style.opacity = 0;
  }
}

function render() {
  $('lat').textContent = toDdm(state.lat, 'N', 'S');
  $('lon').textContent = toDdm(state.lon, 'E', 'W');
  $('sog').textContent = state.sog != null ? state.sog.toFixed(1) : '—';
  $('cog').textContent = state.cog != null ? Math.round(state.cog).toString().padStart(3, '0') : '---';
  $('sats').textContent = state.satellites ?? '—';
  $('time').textContent = state.time ? `${new Date(state.time).toISOString().slice(11, 19)} UTC` : '--:--:-- UTC';
  $('logged').textContent = (loggedMeters / 1852).toFixed(1);
  renderDepth();

  if (state.lat == null) return;
  const pos = [state.lat, state.lon];
  if (!shipMarker) {
    shipMarker = L.marker(pos, { icon: shipIcon, zIndexOffset: 1000, interactive: false }).addTo(map);
    map.setView(pos, 12);
  } else {
    shipMarker.setLatLng(pos);
  }
  setNeedle(state.cog, state.hdg);
  if (state.follow) map.panTo(pos, { animate: true });
}

window.ship.onFix((fix) => {
  if (!fix.valid) return;
  // Sensor sentences from the phone (heading, pressure) arrive between position fixes.
  if (fix.heading != null) {
    state.phoneHdg = fix.heading;
    state.hdg = hdgCal.heading(fix.heading);
    setNeedle(state.cog, state.hdg);
    return;
  }
  if (fix.pressure != null) {
    barometer.add(fix.pressure);
    renderBaro();
    return;
  }
  for (const key of ['lat', 'lon', 'sog', 'cog', 'satellites', 'time']) {
    if (fix[key] != null) state[key] = fix[key];
  }
  state.lastFix = fix.receivedAt;
  state.source = fix.source;
  if (fix.sog != null) speedAvg.add(fix.sog, fix.receivedAt);
  if (fix.type === 'RMC') learnHeadingOffset();
  if (fix.lat != null && fix.lon != null) addTrackPoint(fix.lat, fix.lon, fix.time);
  render();
  applyTheme();
  planner.update();
  renderVoyage();
  renderCabin();
  // Sky card follows the ship: refresh at the first fix and after moving ~30 nm.
  if (state.lat != null && (!skyAt || Math.abs(state.lat - skyAt[0]) + Math.abs(NavCore.wrapLon(state.lon - skyAt[1])) > 0.5)) {
    renderSky();
  }
  if (Date.now() - lastAisRefresh > 10e3) {
    lastAisRefresh = Date.now();
    aisLayer.refresh();
  }
});

// --- Phone compass: heading with the mounting offset learnt from COG ---

const hdgCal = new NavCore.HeadingCalibration();
let savedOffset = null;
function learnHeadingOffset() {
  hdgCal.add(state.cog, state.phoneHdg, state.sog);
  if (hdgCal.offset != null && (savedOffset == null || Math.abs(NavCore.wrapLon(hdgCal.offset - savedOffset)) > 2)) {
    savedOffset = hdgCal.offset;
    window.ship.saveSettings({ hdgOffset: savedOffset });
  }
}

// --- Barometer ---

const barometer = new Barometer({
  load: () => window.ship.loadData('pressure'),
  save: (samples) => window.ship.saveData('pressure', samples),
  onAlert: (tr) => showAlert(tr.alert === 'severe'
    ? `Storm warning: pressure fell ${Math.abs(tr.change3h).toFixed(1)} hPa in 3 hours`
    : `Gale warning: pressure falling fast (${tr.change3h != null ? tr.change3h.toFixed(1) + ' hPa / 3 h' : tr.change1h.toFixed(1) + ' hPa / 1 h'})`),
});

function renderBaro() {
  const tr = barometer.trend();
  $('baro-card').hidden = !tr;
  if (!tr) return;
  $('baro-value').textContent = tr.hPa.toFixed(1);
  const ch = tr.change3h ?? tr.change1h;
  const span = tr.change3h != null ? '3h' : '1h';
  const el = $('baro-trend');
  el.textContent = ch == null ? 'collecting…' : `${ch > 0.2 ? '↗' : ch < -0.2 ? '↘' : '→'} ${ch > 0 ? '+' : ''}${ch.toFixed(1)} / ${span}`;
  el.className = `baro-trend ${tr.alert ? 'storm' : ch != null && ch < -1 ? 'falling' : ''}`;
  $('baro-spark').innerHTML = barometer.svg(barometer.span(3, 24), 130, 34);
}
barometer.ready.then(renderBaro);
setInterval(renderBaro, 60e3);
$('baro-card').onclick = () => {
  const tr = barometer.trend();
  $('baro-chart').innerHTML = barometer.svg(barometer.span(6, 72), Math.min(1000, window.innerWidth * 0.85), 320, { axes: true });
  $('baro-dlg-trend').textContent = tr
    ? `${tr.hPa.toFixed(1)} hPa · 1 h: ${tr.change1h != null ? tr.change1h.toFixed(1) : '—'} · 3 h: ${tr.change3h != null ? tr.change3h.toFixed(1) : '—'}`
    : '';
  $('baro-dialog').showModal();
};

// --- Alerts ---

function showAlert(text) {
  $('alert-text').textContent = text;
  $('alert-bar').hidden = false;
  alarmTone();
  try { new Notification('Ship Cabin Chart', { body: text, silent: true }); } catch { /* notifications off */ }
}
$('alert-close').onclick = () => { $('alert-bar').hidden = true; };

// --- AIS ---

let lastAisRefresh = 0;
function ownForCpa() {
  return state.lat != null ? { lat: state.lat, lon: state.lon, sog: state.sog || 0, cog: state.cog || 0 } : null;
}
window.ship.onAis((msg) => {
  aisLayer.update(msg);
  const st = aisLayer.stats();
  $('status-ais').textContent = `AIS · ${st.total} target${st.total === 1 ? '' : 's'}${st.danger ? ` · ${st.danger} close` : ''}`;
});

// --- Sun, moon and ship time ---

function moonSvg(m) {
  // Lit part of the disc: the terminator is an ellipse whose width follows the illumination.
  const k = 1 - 2 * m.illumination; // 1 new … -1 full
  const rx = Math.abs(k) * 9;
  const sweep = m.waxing ? 1 : 0;
  const lit = `M0,-9 A9,9 0 0 ${sweep} 0,9 A${rx},9 0 0 ${k > 0 ? 1 - sweep : sweep} 0,-9 Z`;
  return `<circle class="dark" r="9"/><path class="lit" d="${lit}"/>`;
}

function fmtZone(t, offsetH) {
  return t ? new Date(t + offsetH * 3600e3).toISOString().slice(11, 16) : '--:--';
}

let skyAt = null;
function renderSky() {
  const pos = state.lat != null ? [state.lat, state.lon] : (() => { const c = map.getCenter(); return [c.lat, c.lng]; })();
  skyAt = state.lat != null ? pos : null;
  const z = Sun.zoneTime(pos[1]);
  $('ship-time').textContent = z.local.toISOString().slice(11, 16);
  $('zone-label').textContent = `· ${z.label}`;
  const t = Sun.sunTimes(pos[0], pos[1]);
  $('sunrise').textContent = t.polarDay ? 'polar' : t.polarNight ? 'polar' : fmtZone(t.sunrise, z.offset);
  $('sunset').textContent = t.polarDay ? 'day' : t.polarNight ? 'night' : fmtZone(t.sunset, z.offset);
  const m = Sun.moonPhase();
  $('moon-icon').innerHTML = moonSvg(m);
  $('moon-pct').textContent = `${Math.round(m.illumination * 100)}%`;
  $('moon').title = `${m.name}, ${Math.round(m.illumination * 100)}% lit`;
}
renderSky();
setInterval(renderSky, 30e3);

// --- Cabin display: big numbers on the whole screen ---

function renderCabin() {
  if ($('cabin').hidden) return;
  $('cb-sog').textContent = state.sog != null ? state.sog.toFixed(1) : '—';
  $('cb-cog').textContent = state.cog != null ? String(Math.round(state.cog)).padStart(3, '0') : '—';
  $('cb-hdg').textContent = state.hdg != null ? `heading ${String(Math.round(state.hdg)).padStart(3, '0')}°` : '';
  $('cb-lat').textContent = toDdm(state.lat, 'N', 'S');
  $('cb-lon').textContent = toDdm(state.lon, 'E', 'W');
  const lon = state.lon ?? map.getCenter().lng;
  const z = Sun.zoneTime(lon);
  $('cb-time').textContent = z.local.toISOString().slice(11, 16);
  $('cb-zone').textContent = `· ${z.label}`;
  $('cb-utc').textContent = `${new Date().toISOString().slice(11, 16)} UTC`;
  const s = planner.summary();
  $('cb-dtg').textContent = s ? `${Voyage.fmtNm(s.dtg)} nm` : '—';
  $('cb-eta').textContent = s && s.eta ? `ETA ${s.eta.at} · ${s.eta.in}` : s ? 'ETA needs a speed' : 'no route';
  const d = formatDepth(state.lat != null ? world.depthAt(state.lat, state.lon) : null);
  $('cb-depth').textContent = `${d.value}${d.unit ? ' ' + d.unit : ''}`;
  const tr = barometer.trend();
  $('cb-baro').textContent = tr ? `${tr.hPa.toFixed(1)} hPa${tr.change3h != null ? ` · ${tr.change3h > 0 ? '+' : ''}${tr.change3h.toFixed(1)}/3h` : ''}` : '';
}
async function setCabin(on) {
  $('cabin').hidden = !on;
  await window.ship.setFullscreen(on);
  renderCabin();
}
$('btn-display').onclick = () => setCabin(true);
$('cabin').onclick = () => setCabin(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('cabin').hidden) setCabin(false); });
setInterval(renderCabin, 5000);

// --- Ports on the chart: sea distance and ETA from the ship ---

async function showPortPopup(port, marker) {
  await routerReady;
  const ship = shipPosition();
  const popup = L.popup({ className: 'port-popup', maxWidth: 300 }).setLatLng([port.lat, port.lon]);
  if (!ship) {
    popup.setContent(`<div class="port-title">${escapeHtml(port.name)}</div><p>Distance appears once the phone sends a position.</p>`).openOn(map);
    return;
  }
  const r = router.route([ship.lat, ship.lon], [port.lat, port.lon], planner.avoid);
  if (!r) {
    popup.setContent(`<div class="port-title">${escapeHtml(port.name)}</div><p>No sea route found.</p>`).openOn(map);
    return;
  }
  const speed = etaKnots();
  const eta = speed ? Voyage.fmtEta(r.distanceNm / speed) : null;
  const via = r.passages.map((x) => Voyage.PASSAGE_NAMES[x] || x).join(', ');
  const avoided = planner.avoid.filter((x) => x !== 'northwest').map((x) => Voyage.PASSAGE_NAMES[x] || x).join(', ');
  popup.setContent(`
    <div class="port-title">⚓ ${escapeHtml(port.name)}</div>
    <div class="port-sub">by sea from the ship${via ? ` · via ${escapeHtml(via)}` : ''}${avoided ? `<br>avoiding ${escapeHtml(avoided)} (Ports → Avoid)` : ''}</div>
    <div class="port-big">${Voyage.fmtNm(r.distanceNm)} <small>nm</small></div>
    <p>${eta ? `ETA ${eta.at}<br>${eta.in} at ${speed.toFixed(1)} kn` : 'ETA: set a speed (voyage bar) or get under way'}</p>
    <button type="button" class="route-here">Route here</button>`).openOn(map);
  popup.getElement().querySelector('.route-here').onclick = () => {
    map.closePopup();
    setRouteFromPoints(r.points, 'from ship');
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function setRouteFromPoints(points, note) {
  previewLayer.clearLayers();
  planner.route = {
    waypoints: points.map(([lat, lon], i) => ({ lat, lon, auto: i > 0 && i < points.length - 1, start: i === 0 })),
    active: 1,
  };
  planner.startNote = note;
  planner.progress = null;
  planner.redraw();
  planner.update();
  planner.persist();
  renderVoyage();
  setFollow(false);
  map.fitBounds(L.polyline(points).getBounds(), { paddingTopLeft: [60, 100], paddingBottomRight: [380, 60] });
}

// --- Voyage: route planning from the GPS position, ETA, distance to go ---

const speedAvg = new NavCore.SpeedAverage();
let etaSpeed = null; // null = average SOG, otherwise planned knots
let router = null;
let distanceTable = null;

function etaKnots() {
  if (etaSpeed) return etaSpeed;
  const v = speedAvg.value;
  return v != null && v >= 0.5 ? v : null;
}

function shipPosition() {
  if (state.lat != null) return { lat: state.lat, lon: state.lon };
  const last = track[track.length - 1];
  return last ? { lat: last[0], lon: last[1] } : null;
}

const planner = new Voyage.RoutePlanner({
  map,
  router: () => router,
  getShip: shipPosition,
  getSpeed: etaKnots,
  save: (route) => window.ship.saveRoute(route),
  onChange: () => renderVoyage(),
});

const measure = new Voyage.MeasureTool(map, () => {
  $('measure-bar').hidden = true;
  $('btn-measure').classList.remove('on');
});

function renderVoyage() {
  const planning = planner.planning;
  $('plan-bar').hidden = !planning;
  document.body.classList.toggle('planning-mode', planning);
  $('btn-route').classList.toggle('on', planning || !!planner.route);
  if (planning) $('pb-start').textContent = planner.startNote ? `· ${planner.startNote}` : '';
  $('pb-arctic').checked = !planner.avoid.includes('northwest');

  const s = planner.summary();
  $('voyage-bar').hidden = !s;
  if (!s) return;
  const bar = $('voyage-bar');
  bar.classList.toggle('arrived', !!s.arrived);
  $('vb-next-n').textContent = s.next ? `WP ${s.next}` : '';
  $('vb-next').textContent = s.toNext != null ? `${Voyage.fmtBrg(s.brgNext)} ${Voyage.fmtNm(s.toNext)}nm` : '—';
  $('vb-xte').textContent = s.xte != null
    ? `${Math.abs(s.xte) < 0.05 ? '0.0' : Math.abs(s.xte).toFixed(Math.abs(s.xte) < 10 ? 2 : 1)}${Math.abs(s.xte) < 0.05 ? '' : s.xte > 0 ? ' S' : ' P'}`
    : '—';
  $('vb-dtg').textContent = s.arrived ? 'Arrived' : `${Voyage.fmtNm(s.dtg)} nm`;
  $('vb-eta').textContent = s.eta ? s.eta.at : '—';
  $('vb-ttg').textContent = s.eta ? `in ${s.eta.in}` : 'set a speed';
  $('vb-speed').textContent = s.speed ? `@ ${s.speed.toFixed(1)} kn ${etaSpeed ? 'plan' : 'avg'}` : '@ — kn';
}
setInterval(renderVoyage, 15000); // ETA clock keeps moving even without new fixes

$('btn-route').onclick = () => {
  if (planner.planning) {
    planner.finishPlanning();
    return;
  }
  measure.stop();
  setFollow(false);
  planner.startPlanning();
};
$('pb-done').onclick = () => planner.finishPlanning();
$('pb-undo').onclick = () => planner.undo();
$('pb-clear').onclick = () => planner.clear();
$('pb-arctic').onchange = (e) => {
  planner.avoid = e.target.checked ? planner.avoid.filter((x) => x !== 'northwest') : [...new Set([...planner.avoid, 'northwest'])];
  planner.persist();
};
$('vb-edit').onclick = () => { measure.stop(); planner.startPlanning(); };
$('vb-end').onclick = () => {
  if (!confirm('Delete the planned route?')) return;
  planner.clear();
};
$('vb-gpx').onclick = async () => {
  if (!planner.route) return;
  const res = await window.ship.exportRouteGpx(planner.route.waypoints);
  if (res.ok) $('status-map').textContent = `Route saved: ${res.path}`;
};
$('vb-rtz').onclick = async () => {
  if (!planner.route) return;
  const res = await window.ship.exportRouteRtz(planner.route.waypoints, planner.route.name);
  if (res.ok) $('status-map').textContent = `Route saved for ECDIS: ${res.path}`;
  else if (res.error) alert(res.error);
};

// Route from ECDIS (.rtz) or GPX: every point becomes a user waypoint that can be dragged.
async function importRoute() {
  const res = await window.ship.importRoute();
  if (!res.ok) {
    if (res.error) alert(`Cannot import the route: ${res.error}`);
    return;
  }
  planner.finishPlanning();
  measure.stop();
  const wps = res.waypoints.map((w) => ({ lat: w.lat, lon: w.lon, name: w.name }));
  for (let i = 1; i < wps.length; i++) wps[i].lon = wps[i - 1].lon + NavCore.wrapLon(wps[i].lon - wps[i - 1].lon);
  wps[0].start = true;
  previewLayer.clearLayers();
  planner.route = { waypoints: wps, active: 1, name: res.name || res.file };
  planner.startNote = `imported ${res.file}`;
  planner.progress = null;
  planner.redraw();
  planner.update();
  planner.persist();
  renderVoyage();
  setFollow(false);
  map.fitBounds(L.polyline(wps.map((w) => [w.lat, w.lon])).getBounds(), { paddingTopLeft: [60, 100], paddingBottomRight: [380, 60] });
  $('status-map').textContent = `Route imported: ${res.name || res.file} · ${wps.length} waypoints`;
}
$('pb-import').onclick = importRoute;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o' && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    importRoute();
  }
});
$('vb-speed').onclick = () => {
  document.querySelector(`input[name="speed-mode"][value="${etaSpeed ? 'manual' : 'avg'}"]`).checked = true;
  if (etaSpeed) $('speed-manual').value = etaSpeed;
  $('speed-dialog').showModal();
};
$('speed-dialog').addEventListener('close', () => {
  if ($('speed-dialog').returnValue !== 'save') return;
  const manual = document.querySelector('input[name="speed-mode"]:checked').value === 'manual';
  etaSpeed = manual ? Math.max(0.5, parseFloat($('speed-manual').value) || 12) : null;
  window.ship.saveSettings({ etaSpeed });
  renderVoyage();
});

$('btn-measure').onclick = () => {
  if (measure.active) {
    measure.stop();
    return;
  }
  if (planner.planning) planner.finishPlanning();
  setFollow(false);
  measure.start();
  $('measure-bar').hidden = false;
  $('btn-measure').classList.add('on');
};
$('mb-done').onclick = () => measure.stop();

// Sea distances between ports; the network loads lazily the first time it's needed.
const routerReady = (async () => {
  router = new NavCore.SeaRouter(JSON.parse(await window.ship.loadWorldLayer('sea-routes')));
  distanceTable = JSON.parse(await window.ship.loadWorldLayer('distance-table'));
})();

const previewLayer = L.layerGroup().addTo(map);
let distancesReady = false;
$('btn-ports').onclick = async () => {
  await routerReady;
  if (!distancesReady) {
    distancesReady = true;
    Voyage.setupDistances({
      dialog: $('ports-dialog'),
      router: () => router,
      table: distanceTable,
      getShip: shipPosition,
      getSpeed: etaKnots,
      avoidRef: (next) => (next ? (planner.avoid = next) : planner.avoid),
      showRoute: (r) => {
        previewLayer.clearLayers();
        const line = L.polyline(r.points, { className: 'route-line preview', weight: 3, interactive: false }).addTo(previewLayer);
        L.marker(r.points[r.points.length - 1], {
          icon: L.divIcon({ className: 'leg-label route', html: `<span>${r.from.name} → ${r.to.name} · ${Voyage.fmtNm(r.distanceNm)} nm</span>`, iconSize: [0, 0] }),
          interactive: false,
        }).addTo(previewLayer);
        setFollow(false);
        map.fitBounds(line.getBounds(), { paddingTopLeft: [60, 60], paddingBottomRight: [380, 60] });
        setTimeout(() => previewLayer.clearLayers(), 60000);
      },
      useRoute: (r) => setRouteFromPoints(r.points, r.from.name === 'Ship' ? 'from ship' : `from ${r.from.name}`),
    });
  }
  $('ports-dialog').showModal();
};
map.on('zoomend', () => planner.route && !planner.planning && planner.redraw());

window.ship.onStatus((s) => {
  if (s.udp) $('status-udp').textContent = `UDP · ${s.udp}`;
  if (s.tcp) $('status-tcp').textContent = `TCP · ${s.tcp}`;
});

// Link indicator: live < 5 s, stale < 30 s, otherwise no signal.
setInterval(() => {
  const age = state.lastFix ? (Date.now() - state.lastFix) / 1000 : Infinity;
  const pill = $('link');
  pill.dataset.state = age < 5 ? 'ok' : age < 30 ? 'stale' : 'none';
  $('link-text').textContent = age < 5 ? 'Live' : age < 30 ? 'Stale' : 'No signal';
  $('age').textContent = Number.isFinite(age)
    ? `${state.source || ''} · ${age < 60 ? Math.round(age) + 's' : Math.round(age / 60) + 'm'} ago`
    : '';
}, 1000);

setInterval(() => {
  if (!trackDirty) return;
  trackDirty = false;
  window.ship.saveTrack(track);
}, 30000);

// --- Compass dial ticks ---

(function drawDial() {
  const g = $('dial-ticks');
  for (let deg = 0; deg < 360; deg += 5) {
    const major = deg % 30 === 0;
    const r1 = major ? 80 : 85;
    const a = (deg * Math.PI) / 180;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', (Math.sin(a) * r1).toFixed(2));
    line.setAttribute('y1', (-Math.cos(a) * r1).toFixed(2));
    line.setAttribute('x2', (Math.sin(a) * 91).toFixed(2));
    line.setAttribute('y2', (-Math.cos(a) * 91).toFixed(2));
    if (major) line.setAttribute('class', 'major');
    g.appendChild(line);
  }
})();

// --- Theme: day / night / auto (by the sun at the ship's position) ---

const THEME_MODES = ['auto', 'night', 'red', 'day'];
const THEME_ICONS = {
  red: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  night: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  day: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
};
let themeMode = 'auto';

function resolveTheme() {
  if (themeMode !== 'auto') return themeMode;
  const center = state.lat != null ? [state.lat, state.lon] : null;
  if (center) return Sun.sunElevation(center[0], center[1]) < -6 ? 'night' : 'day';
  const h = new Date().getHours();
  return h >= 7 && h < 19 ? 'day' : 'night';
}

function applyTheme() {
  const theme = resolveTheme();
  $('theme-label').textContent = themeMode === 'auto' ? `Auto · ${theme}` : theme === 'red' ? 'Red night' : theme[0].toUpperCase() + theme.slice(1);
  $('theme-icon').innerHTML = THEME_ICONS[themeMode];
  if (document.body.dataset.theme === theme) return;
  document.body.dataset.theme = theme;
  world.setTheme(theme);
  depthLegend.render(world.legend());
}

$('btn-theme').onclick = () => {
  themeMode = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
  window.ship.saveSettings({ themeMode });
  applyTheme();
};
setInterval(applyTheme, 60000);

// --- Buttons ---

function setFollow(on) {
  state.follow = on;
  $('btn-follow').classList.toggle('on', on);
}
$('btn-follow').onclick = () => {
  setFollow(!state.follow);
  window.ship.saveSettings({ follow: state.follow });
  render();
};
map.on('dragstart', () => setFollow(false));

$('btn-clear').onclick = () => {
  if (!confirm('Clear the recorded track?')) return;
  track = [];
  loggedMeters = 0;
  trackLine.setLatLngs([]);
  window.ship.saveTrack(track);
  render();
};

$('btn-gpx').onclick = async () => {
  if (!track.length) {
    alert('The track is empty.');
    return;
  }
  const res = await window.ship.exportGpx(track);
  if (res.ok) $('status-map').textContent = `Track saved: ${res.path}`;
};

$('btn-settings').onclick = async () => {
  const s = await window.ship.getSettings();
  $('my-ip').textContent = s.addresses.join(', ') || 'no network';
  $('udp-port').value = s.udpPort;
  $('tcp-host').value = s.tcpHost;
  $('tcp-port').value = s.tcpPort;
  $('data-dir').textContent = s.dataDir;
  $('app-version').textContent = s.version;
  $('hdg-offset').textContent = hdgCal.offset != null ? `${Math.round(hdgCal.offset)}°` : 'not calibrated yet';
  $('settings').showModal();
  const qrs = await window.ship.pairingQr();
  $('pairing-qr').innerHTML = qrs.length
    ? qrs.map((q) => `<figure><img src="${q.url}" alt="QR code"><figcaption>${q.ip}:${s.udpPort}</figcaption></figure>`).join('')
    : '<p class="muted">No network: connect this computer to the phone\'s Wi-Fi first.</p>';
};
$('hdg-reset').onclick = () => {
  hdgCal.offset = null;
  hdgCal.samples = [];
  savedOffset = null;
  state.hdg = null;
  window.ship.saveSettings({ hdgOffset: null });
  $('hdg-offset').textContent = 'not calibrated yet';
};
$('update-check').onclick = () => checkUpdates(true);
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  window.ship.saveSettings({
    udpPort: parseInt($('udp-port').value, 10) || 10110,
    tcpHost: $('tcp-host').value.trim(),
    tcpPort: parseInt($('tcp-port').value, 10) || 10110,
  });
});

function downloadOptions() {
  const b = map.getBounds();
  return {
    mode: document.querySelector('input[name="dl-mode"]:checked').value,
    minZoom: parseInt($('dl-min').value, 10),
    maxZoom: parseInt($('dl-max').value, 10),
    layers: $('dl-seamark').checked ? ['osm', 'seamark'] : ['osm'],
    radiusNm: parseFloat($('dl-radius').value) || 10,
    coastOnly: $('dl-coast').checked,
    points: planner.points(),
    north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
  };
}

const dryRun = (o) => (o.mode === 'route' ? window.ship.downloadCorridor({ ...o, dryRun: true }) : window.ship.downloadArea({ ...o, dryRun: true }));

// Highest max zoom whose tiles (from min zoom up) fit in the download limit.
function fittingZoom(r, minZoom) {
  let sum = 0, best = null;
  for (let z = minZoom; r.perZoom[z] != null; z++) {
    sum += r.perZoom[z];
    if (sum > r.limit) break;
    best = { zoom: z, count: sum };
  }
  return best;
}

let estimateSeq = 0;
async function updateEstimate() {
  const o = downloadOptions();
  const seq = ++estimateSeq;
  $('dl-fit').hidden = true;
  if (o.mode === 'route' && o.points.length < 2) {
    $('dl-estimate').textContent = 'Plan a route first (Route button).';
    return;
  }
  const r = await dryRun(o);
  if (seq !== estimateSeq) return; // a newer estimate is on its way
  if (!r.ok) {
    $('dl-estimate').textContent = r.error;
    return;
  }
  const n = (v) => v.toLocaleString('en-US');
  if (r.count <= r.limit) {
    $('dl-estimate').textContent = `${n(r.count)} tiles — ready to download.`;
    return;
  }
  const fit = fittingZoom(r, o.minZoom);
  $('dl-estimate').textContent = `${n(r.count)} tiles: more than the ${n(r.limit)} allowed per download by the free map servers.`;
  if (fit) {
    $('dl-fit').textContent = `Use max zoom ${fit.zoom} (${n(fit.count)} tiles)`;
    $('dl-fit').hidden = false;
    $('dl-fit').onclick = () => {
      $('dl-max').value = fit.zoom;
      updateEstimate();
    };
  } else {
    $('dl-estimate').textContent += ' Raise the min zoom, narrow the corridor or zoom in.';
  }
}

$('btn-download').onclick = () => {
  $('dl-progress').textContent = '';
  if (planner.points().length >= 2) document.querySelector('input[name="dl-mode"][value="route"]').checked = true;
  $('download').showModal();
  updateEstimate();
};
$('download').addEventListener('change', updateEstimate);
$('download').addEventListener('input', updateEstimate);
$('dl-start').onclick = async () => {
  const o = downloadOptions();
  if (o.mode === 'route' && o.points.length < 2) return;
  // Over the limit: cap the max zoom instead of refusing.
  const est = await dryRun(o);
  let note = '';
  if (est.ok && est.count > est.limit) {
    const fit = fittingZoom(est, o.minZoom);
    if (!fit) {
      $('dl-progress').textContent = 'Still too many tiles even at the min zoom.';
      return;
    }
    note = ` (max zoom lowered to ${fit.zoom} to stay within the limit)`;
    o.maxZoom = fit.zoom;
    $('dl-max').value = fit.zoom;
  }
  $('dl-start').disabled = true;
  $('dl-progress').textContent = `Downloading…${note}`;
  const res = o.mode === 'route' ? await window.ship.downloadCorridor(o) : await window.ship.downloadArea(o);
  $('dl-start').disabled = false;
  if (!res.ok) {
    $('dl-progress').textContent = res.error;
  } else if (res.done && res.failed === res.done) {
    $('dl-progress').textContent = `Nothing downloaded: ${res.error || 'no connection'}. Check the internet connection and try again.`;
  } else {
    $('dl-progress').textContent = `Done: ${res.done - res.failed} tiles saved${res.failed ? `, ${res.failed} failed (${res.error})` : ''}${note}. They now work offline.`;
  }
  updateEstimate();
};
window.ship.onDownloadProgress((p) => {
  $('dl-progress').textContent = `Downloading ${p.done} / ${p.total}${p.failed ? `, ${p.failed} failed` : ''}…`;
});

// --- Startup ---

(async () => {
  const s = await window.ship.getSettings();
  setFollow(s.follow);
  themeMode = THEME_MODES.includes(s.themeMode) ? s.themeMode : 'auto';
  applyTheme();
  etaSpeed = s.etaSpeed || null;
  if (s.hdgOffset != null) {
    hdgCal.offset = s.hdgOffset;
    savedOffset = s.hdgOffset;
  }
  $('status-version').textContent = `v${s.version}`;
  setTimeout(() => checkUpdates(false), 15e3);
  if (s.tss === false) {
    map.removeLayer(tssToggle);
    world.setVisible('tss', false);
  }
  if (s.limits === false) {
    map.removeLayer(limitsToggle);
    world.setVisible('limits', false);
  }
  if (s.grid === false) {
    map.removeLayer(gridLabels);
    world.setGraticule(false);
  }
  planner.load(await window.ship.loadRoute());
  renderVoyage();
  track = await window.ship.loadTrack();
  trackLine.setLatLngs(track.map((p) => [p[0], p[1]]));
  recomputeLogged();
  render();
  if (track.length) map.setView(track[track.length - 1].slice(0, 2), 11);
})();

// --- Updates from GitHub Releases ---

async function checkUpdates(manual) {
  const r = await window.ship.checkUpdate();
  const msg = !r.ok
    ? r.reason === 'offline' ? 'no internet' : r.reason === 'private' ? 'the release page is private, updates need a public repository' : `update server unavailable (${r.reason})`
    : r.available ? `${r.latest} is available` : `up to date (${r.current})`;
  $('update-check-result').textContent = msg;
  if (r.ok && r.available && r.asset) {
    $('update-version').textContent = r.latest;
    $('update-status').textContent = `${(r.asset.size / 1048576).toFixed(0)} MB`;
    $('update-bar').hidden = false;
  } else if (manual && $('settings').open === false) {
    $('status-map').textContent = `Updates: ${msg}`;
  }
}
$('update-later').onclick = () => { $('update-bar').hidden = true; };
$('update-go').onclick = async () => {
  $('update-go').disabled = true;
  $('update-status').textContent = 'downloading…';
  const r = await window.ship.downloadUpdate();
  if (!r.ok) {
    $('update-status').textContent = r.error;
    $('update-go').disabled = false;
    return;
  }
  $('update-status').textContent = 'starting the new version…';
  const started = await window.ship.launchUpdate(r.path);
  if (!started) $('update-status').textContent = `saved to ${r.path}`;
};
window.ship.onUpdateProgress((p) => {
  $('update-status').textContent = `downloading ${Math.round((100 * p.got) / (p.total || p.got))}%`;
});

// --- Right click: coordinates of any point ---

map.on('contextmenu', (e) => {
  const { lat, lng } = e.latlng.wrap();
  const ddm = `${toDdm(lat, 'N', 'S')}  ${toDdm(lng, 'E', 'W')}`;
  const dec = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const d = formatDepth(world.depthAt(lat, lng));
  const ship = shipPosition();
  const rb = ship ? NavCore.rhumb([ship.lat, ship.lon], [lat, lng]) : null;
  const popup = L.popup({ className: 'port-popup point-popup', maxWidth: 300 })
    .setLatLng(e.latlng)
    .setContent(`
      <div class="port-title">${toDdm(lat, 'N', 'S')}<br>${toDdm(lng, 'E', 'W')}</div>
      <div class="port-sub">${dec}</div>
      <p>Chart depth: ${d.value}${d.unit ? ' ' + d.unit : ''}</p>
      ${rb ? `<p>From ship: ${Voyage.fmtBrg(rb.bearing)} · ${Voyage.fmtNm(rb.distanceNm)} nm</p>` : ''}
      <div class="pt-actions">
        <button type="button" data-a="copy">Copy</button>
        <button type="button" data-a="route">${planner.route ? 'Add waypoint' : 'Route here'}</button>
        <button type="button" data-a="measure">Measure from here</button>
      </div>`)
    .openOn(map);
  const el = popup.getElement();
  el.querySelector('[data-a="copy"]').onclick = async (ev) => {
    await window.ship.copyText(`${ddm}  (${dec})`);
    ev.target.textContent = 'Copied ✓';
  };
  el.querySelector('[data-a="route"]').onclick = async () => {
    map.closePopup();
    if (planner.route) {
      planner.addWaypoint([lat, lng]);
      return;
    }
    await routerReady;
    const from = shipPosition();
    const r = from && router.route([from.lat, from.lon], [lat, lng], planner.avoid);
    if (r) setRouteFromPoints(r.points, 'from ship');
    else {
      planner.startPlanning();
      planner.addWaypoint([lat, lng]);
    }
  };
  el.querySelector('[data-a="measure"]').onclick = () => {
    map.closePopup();
    if (planner.planning) planner.finishPlanning();
    measure.start();
    $('measure-bar').hidden = false;
    $('btn-measure').classList.add('on');
    measure.add([lat, lng]);
  };
});
