'use strict';

const $ = (id) => document.getElementById(id);

const map = L.map('map', { zoomControl: true, worldCopyJump: true, maxZoom: 18 }).setView([30, 0], 3);
map.zoomControl.setPosition('topleft');

// Built-in offline world chart: always available, no internet needed.
const world = WorldChart.createWorldChart(map, window.ship.loadWorldLayer);
world.chart.addTo(map);
world.labels.addTo(map);
world.ready
  .then(() => { $('status-map').textContent = 'World chart · offline · built in'; })
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
L.control.layers(null, {
  'Place names, ports': world.labels,
  'OpenStreetMap detail (zoom 9+)': osm,
  'Seamarks (zoom 9+)': seamarks,
}, { position: 'topleft' }).addTo(map);
L.control.scale({ metric: true, imperial: true, position: 'bottomleft' }).addTo(map);

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

function setNeedle(cog) {
  const angle = cog || 0;
  $('needle').style.transform = `rotate(${angle}deg)`;
  if (shipMarker) {
    const svg = shipMarker.getElement()?.querySelector('svg');
    if (svg) svg.style.transform = `rotate(${angle}deg)`;
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

  if (state.lat == null) return;
  const pos = [state.lat, state.lon];
  if (!shipMarker) {
    shipMarker = L.marker(pos, { icon: shipIcon, zIndexOffset: 1000, interactive: false }).addTo(map);
    map.setView(pos, 12);
  } else {
    shipMarker.setLatLng(pos);
  }
  setNeedle(state.cog);
  if (state.follow) map.panTo(pos, { animate: true });
}

window.ship.onFix((fix) => {
  if (!fix.valid) return;
  for (const key of ['lat', 'lon', 'sog', 'cog', 'satellites', 'time']) {
    if (fix[key] != null) state[key] = fix[key];
  }
  state.lastFix = fix.receivedAt;
  state.source = fix.source;
  if (fix.lat != null && fix.lon != null) addTrackPoint(fix.lat, fix.lon, fix.time);
  render();
  applyTheme();
});

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

const THEME_MODES = ['auto', 'night', 'day'];
const THEME_ICONS = {
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
  $('theme-label').textContent = themeMode === 'auto' ? `Auto · ${theme}` : theme[0].toUpperCase() + theme.slice(1);
  $('theme-icon').innerHTML = THEME_ICONS[themeMode];
  if (document.body.dataset.theme === theme) return;
  document.body.dataset.theme = theme;
  world.setTheme(theme);
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
  $('settings').showModal();
};
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  window.ship.saveSettings({
    udpPort: parseInt($('udp-port').value, 10) || 10110,
    tcpHost: $('tcp-host').value.trim(),
    tcpPort: parseInt($('tcp-port').value, 10) || 10110,
  });
});

$('btn-download').onclick = () => {
  $('dl-progress').textContent = '';
  $('download').showModal();
};
$('dl-start').onclick = async () => {
  const b = map.getBounds();
  const minZoom = parseInt($('dl-min').value, 10);
  const maxZoom = parseInt($('dl-max').value, 10);
  const layers = $('dl-seamark').checked ? ['osm', 'seamark'] : ['osm'];
  $('dl-start').disabled = true;
  $('dl-progress').textContent = 'Downloading…';
  const res = await window.ship.downloadArea({
    north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(), minZoom, maxZoom, layers,
  });
  $('dl-start').disabled = false;
  $('dl-progress').textContent = res.ok
    ? `Done: ${res.done} tiles${res.failed ? `, failed: ${res.failed}` : ''}`
    : res.error;
};
window.ship.onDownloadProgress((p) => {
  $('dl-progress').textContent = `Downloaded ${p.done}${p.failed ? `, failed ${p.failed}` : ''}…`;
});

// --- Startup ---

(async () => {
  const s = await window.ship.getSettings();
  setFollow(s.follow);
  themeMode = THEME_MODES.includes(s.themeMode) ? s.themeMode : 'auto';
  applyTheme();
  track = await window.ship.loadTrack();
  trackLine.setLatLngs(track.map((p) => [p[0], p[1]]));
  recomputeLogged();
  render();
  if (track.length) map.setView(track[track.length - 1].slice(0, 2), 11);
})();
