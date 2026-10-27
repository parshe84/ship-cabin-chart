'use strict';

const $ = (id) => document.getElementById(id);

const map = L.map('map', { zoomControl: true, worldCopyJump: true, maxZoom: 18 }).setView([30, 0], 3);

// Built-in offline world chart: always available, no internet needed.
const world = WorldChart.createWorldChart(map, window.ship.loadWorldLayer);
world.chart.addTo(map);
world.labels.addTo(map);
world.ready
  .then(() => { $('status-map').textContent = 'World chart: offline, built in'; })
  .catch((err) => { $('status-map').textContent = `World chart failed: ${err.message}`; });

// Detailed coastal maps on top when zoomed in: online, or from the download cache.
// Missing tiles are transparent, so the world chart shows through.
const osm = L.tileLayer('tilecache://osm/{z}/{x}/{y}.png', {
  minZoom: 9,
  maxZoom: 18,
  attribution: '© OpenStreetMap contributors',
}).addTo(map);
const seamarks = L.tileLayer('tilecache://seamark/{z}/{x}/{y}.png', {
  minZoom: 9,
  maxZoom: 18,
  attribution: '© OpenSeaMap',
}).addTo(map);
L.control.layers(null, {
  'Place names, ports': world.labels,
  'OpenStreetMap detail (zoom 9+)': osm,
  'Seamarks (zoom 9+)': seamarks,
}, { position: 'topleft' }).addTo(map);
L.control.scale({ metric: true, imperial: true }).addTo(map);

const shipSvg = (cog) => `
  <svg width="36" height="36" viewBox="-18 -18 36 36" style="transform: rotate(${cog || 0}deg)">
    <path d="M0,-16 L9,12 L0,6 L-9,12 Z" fill="#ff4d4f" stroke="#fff" stroke-width="2"/>
  </svg>`;

const shipIcon = (cog) => L.divIcon({ className: '', html: shipSvg(cog), iconSize: [36, 36], iconAnchor: [18, 18] });
let shipMarker = null;
const trackLine = L.polyline([], { color: '#3fb6ff', weight: 3, opacity: 0.8 }).addTo(map);

const state = { lat: null, lon: null, sog: null, cog: null, satellites: null, time: null, lastFix: 0, follow: true };
let track = [];
let trackDirty = false;

function toDdm(value, pos, neg) {
  if (value == null) return '—';
  const hemi = value >= 0 ? pos : neg;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${deg}° ${min.toFixed(3).padStart(6, '0')}′ ${hemi}`;
}

function distanceMeters(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad, dLon = (b[1] - a[1]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function addTrackPoint(lat, lon) {
  const p = [lat, lon];
  const last = track[track.length - 1];
  if (last && distanceMeters(last, p) < 15) return;
  track.push(p);
  if (track.length > 50000) track.shift();
  trackLine.addLatLng(p);
  trackDirty = true;
}

function render() {
  $('lat').textContent = toDdm(state.lat, 'N', 'S');
  $('lon').textContent = toDdm(state.lon, 'E', 'W');
  $('sog').textContent = state.sog != null ? state.sog.toFixed(1) : '—';
  $('cog').textContent = state.cog != null ? Math.round(state.cog).toString().padStart(3, '0') : '—';
  $('sats').textContent = state.satellites ?? '—';
  $('time').textContent = state.time ? new Date(state.time).toISOString().slice(11, 19) : '—';

  if (state.lat == null) return;
  const pos = [state.lat, state.lon];
  if (!shipMarker) {
    shipMarker = L.marker(pos, { icon: shipIcon(state.cog), zIndexOffset: 1000 }).addTo(map);
    map.setView(pos, 13);
  } else {
    shipMarker.setLatLng(pos);
    shipMarker.setIcon(shipIcon(state.cog));
  }
  if (state.follow) map.panTo(pos, { animate: true });
}

window.ship.onFix((fix) => {
  if (!fix.valid) return;
  for (const key of ['lat', 'lon', 'sog', 'cog', 'satellites', 'time']) {
    if (fix[key] != null) state[key] = fix[key];
  }
  state.lastFix = fix.receivedAt;
  $('source').textContent = `Source: ${fix.source}`;
  if (fix.lat != null && fix.lon != null) addTrackPoint(fix.lat, fix.lon);
  render();
});

window.ship.onStatus((s) => {
  if (s.udp) $('status-udp').textContent = `UDP: ${s.udp}`;
  if (s.tcp) $('status-tcp').textContent = `TCP: ${s.tcp}`;
});

// Link indicator: green < 5 s, yellow < 30 s, red otherwise.
setInterval(() => {
  const age = state.lastFix ? (Date.now() - state.lastFix) / 1000 : Infinity;
  const dot = $('link-dot');
  dot.className = 'dot' + (age < 5 ? ' ok' : age < 30 ? ' stale' : '');
  $('age').textContent = Number.isFinite(age)
    ? `Last data: ${age < 60 ? Math.round(age) + ' s' : Math.round(age / 60) + ' min'} ago`
    : 'No data from phone';
}, 1000);

setInterval(() => {
  if (!trackDirty) return;
  trackDirty = false;
  window.ship.saveTrack(track);
}, 30000);

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
  trackLine.setLatLngs([]);
  window.ship.saveTrack(track);
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
  track = await window.ship.loadTrack();
  trackLine.setLatLngs(track);
  if (track.length) map.setView(track[track.length - 1], 12);
})();
