'use strict';

const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const tcp = require('net');
const os = require('os');
const { parseSentence } = require('./nmea');
const { AisDecoder } = require('./ais');
const QRCode = require('qrcode');
const { parseRouteFile, buildRtz } = require('./rtz');
const { EncLibrary } = require('./enc-library');

// Portable mode: keep settings, track and cached tiles next to the .exe.
const dataDir = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'ShipCabinChart-data')
  : path.join(app.getPath('userData'), 'data');
const tilesDir = path.join(dataDir, 'tiles');
const settingsFile = path.join(dataDir, 'settings.json');
fs.mkdirSync(tilesDir, { recursive: true });

const TILE_SOURCES = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  seamark: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
};
const USER_AGENT = `ShipCabinChart/${app.getVersion()} (+https://github.com/parshe84/ship-cabin-chart)`;
const REPO = 'parshe84/ship-cabin-chart';
// The OSM tile usage policy requires a User-Agent that identifies the application.
app.userAgentFallback = USER_AGENT;

const defaultSettings = { udpPort: 10110, tcpHost: '', tcpPort: 10110, follow: true, themeMode: 'auto' };
let settings = { ...defaultSettings };
try {
  settings = { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
} catch { /* first run */ }

function saveSettings() {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'tilecache', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win;
let udpSocket;
let tcpClient;
let tcpReconnectTimer;
let lineBuffer = '';
const ais = new AisDecoder();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function handleData(chunk, source) {
  lineBuffer += chunk.toString('ascii');
  const lines = lineBuffer.split(/\r?\n/);
  lineBuffer = lines.pop();
  for (const line of lines) {
    if (line.startsWith('!')) {
      const msg = ais.push(line);
      if (msg) send('ais', msg);
      continue;
    }
    const fix = parseSentence(line);
    if (fix) send('fix', { ...fix, source, receivedAt: Date.now() });
  }
}

function startUdp() {
  if (udpSocket) udpSocket.close();
  udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udpSocket.on('message', (msg, rinfo) => {
    // Each datagram may carry one or many sentences; make sure it ends with a newline.
    const text = msg.toString('ascii');
    handleData(text.endsWith('\n') ? text : text + '\n', `UDP ${rinfo.address}`);
  });
  udpSocket.on('error', (err) => send('status', { udp: `error: ${err.message}` }));
  udpSocket.bind(settings.udpPort, () => send('status', { udp: `listening on port ${settings.udpPort}` }));
}

function startTcp() {
  clearTimeout(tcpReconnectTimer);
  if (tcpClient) tcpClient.destroy();
  tcpClient = null;
  if (!settings.tcpHost) {
    send('status', { tcp: 'off' });
    return;
  }
  const client = tcp.connect(settings.tcpPort, settings.tcpHost);
  tcpClient = client;
  client.setTimeout(15000);
  client.on('connect', () => send('status', { tcp: `connected to ${settings.tcpHost}:${settings.tcpPort}` }));
  client.on('data', (chunk) => handleData(chunk, `TCP ${settings.tcpHost}`));
  client.on('timeout', () => client.destroy(new Error('no data for 15 s')));
  client.on('error', (err) => send('status', { tcp: `error: ${err.message}` }));
  client.on('close', () => {
    if (tcpClient !== client) return;
    send('status', { tcp: 'reconnecting…' });
    tcpReconnectTimer = setTimeout(startTcp, 3000);
  });
}

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function tilePath(layer, z, x, y) {
  return path.join(tilesDir, layer, String(z), String(x), `${y}.png`);
}

async function fetchTile(layer, z, x, y) {
  const file = tilePath(layer, z, x, y);
  if (fs.existsSync(file)) return fs.promises.readFile(file);
  const url = TILE_SOURCES[layer].replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await net.fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, buf);
  return buf;
}

function registerTileProtocol() {
  // tilecache://osm/{z}/{x}/{y}.png -> disk cache, falls back to the network.
  protocol.handle('tilecache', async (request) => {
    const u = new URL(request.url);
    const layer = u.hostname;
    const [z, x, yPng] = u.pathname.slice(1).split('/');
    const y = parseInt(yPng, 10);
    if (!TILE_SOURCES[layer]) return new Response(null, { status: 404 });
    try {
      const buf = await fetchTile(layer, +z, +x, y);
      return new Response(buf, { headers: { 'Content-Type': 'image/png' } });
    } catch {
      // Offline and not cached: transparent "no tile".
      return new Response(null, { status: 404 });
    }
  });
}

function lon2tile(lon, z) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
function lat2tile(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

const MAX_DOWNLOAD_TILES = 3000; // be polite to the free OSM tile servers

function clampZoom(z) {
  return Math.max(1, Math.min(17, parseInt(z, 10) || 1));
}

async function runDownload(jobs) {
  if (jobs.length > MAX_DOWNLOAD_TILES) {
    return {
      ok: false,
      count: jobs.length,
      error: `Too many tiles (${jobs.length}). Lower the max zoom or the area (limit ${MAX_DOWNLOAD_TILES}).`,
    };
  }
  let done = 0, failed = 0, firstError = null;
  const total = jobs.length;
  const workers = Array.from({ length: 2 }, async () => {
    while (jobs.length) {
      const [layer, z, x, y] = jobs.shift();
      try {
        await fetchTile(layer, z, x, y);
      } catch (e) {
        failed++;
        firstError = firstError || e.message;
      }
      done++;
      if (done % 10 === 0) send('download-progress', { done, failed, total });
    }
  });
  await Promise.all(workers);
  return { ok: true, done, failed, error: firstError };
}

const tileLayers = (layers) => (Array.isArray(layers) ? layers.filter((l) => TILE_SOURCES[l]) : ['osm']);
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// Detailed tiles only matter near land: over the open ocean an OSM tile is a flat blue square.
// COAST_ZOOM tiles that touch a coastline (plus one tile around them) form the "coastal" set.
const COAST_ZOOM = 10;
let coastalTiles = null;
function coastal() {
  if (coastalTiles) return coastalTiles;
  coastalTiles = new Set();
  const n = 2 ** COAST_ZOOM;
  const mark = (lon, lat) => {
    const x = lon2tile(wrapLon(lon), COAST_ZOOM), y = lat2tile(Math.max(-85, Math.min(85, lat)), COAST_ZOOM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) coastalTiles.add(`${(x + dx + n) % n}/${y + dy}`);
    }
  };
  for (const name of ['coastline', 'lakes']) {
    const geo = JSON.parse(fs.readFileSync(path.join(__dirname, 'maps', 'world', `${name}.json`), 'utf8'));
    for (const f of geo.features) {
      const g = f.geometry;
      if (!g) continue;
      const lines = g.type === 'LineString' ? [g.coordinates]
        : g.type === 'MultiLineString' || g.type === 'Polygon' ? g.coordinates
          : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
      for (const line of lines) {
        for (let i = 0; i < line.length; i++) {
          const [lon1, lat1] = line[i];
          mark(lon1, lat1);
          const next = line[i + 1];
          if (!next) continue;
          // Fill long segments so no coastal tile is skipped (step ~ half a tile).
          const steps = Math.ceil(Math.hypot(next[0] - lon1, next[1] - lat1) / (180 / n));
          for (let k = 1; k < steps; k++) mark(lon1 + ((next[0] - lon1) * k) / steps, lat1 + ((next[1] - lat1) * k) / steps);
        }
      }
    }
  }
  return coastalTiles;
}

function isCoastal(z, x, y) {
  const set = coastal();
  if (z >= COAST_ZOOM) {
    const d = z - COAST_ZOOM;
    return set.has(`${x >> d}/${y >> d}`);
  }
  const d = COAST_ZOOM - z;
  for (let cx = x << d; cx < (x + 1) << d; cx++) {
    for (let cy = y << d; cy < (y + 1) << d; cy++) if (set.has(`${cx}/${cy}`)) return true;
  }
  return false;
}

// Tiles of the visible area for each zoom: { z: [[x, y], …] }.
function areaTiles({ north, south, east, west }, minZoom, maxZoom) {
  const out = {};
  const span = Math.min(360, east - west);
  for (let z = clampZoom(minZoom); z <= clampZoom(maxZoom); z++) {
    const n = 2 ** z;
    const tiles = [];
    const x0 = lon2tile(wrapLon(west), z);
    const count = Math.min(n, Math.ceil((span / 360) * n) + 1);
    for (let i = 0; i < count; i++) {
      const x = (x0 + i) % n;
      for (let y = lat2tile(Math.min(85, north), z); y <= lat2tile(Math.max(-85, south), z); y++) tiles.push([x, y]);
    }
    out[z] = tiles;
  }
  return out;
}

// Tiles within `radiusNm` of a route polyline: { z: [[x, y], …] }.
function corridorTiles(points, radiusNm, minZoom, maxZoom) {
  const out = {};
  for (let z = clampZoom(minZoom); z <= clampZoom(maxZoom); z++) {
    const seen = new Set();
    const tiles = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[i + 1] || a;
      // Sample the leg densely enough that the corridor has no gaps.
      const lenNm = Math.hypot((b[0] - a[0]) * 60, (b[1] - a[1]) * 60 * Math.cos((a[0] * Math.PI) / 180));
      const steps = Math.max(1, Math.ceil(lenNm / Math.max(0.5, radiusNm / 2)));
      for (let k = 0; k <= steps; k++) {
        const lat = a[0] + ((b[0] - a[0]) * k) / steps;
        const lon = a[1] + ((b[1] - a[1]) * k) / steps;
        const dLat = radiusNm / 60;
        const dLon = radiusNm / 60 / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
        const n = Math.min(85, lat + dLat), s = Math.max(-85, lat - dLat);
        const x0 = lon2tile(wrapLon(lon - dLon), z), x1 = lon2tile(wrapLon(lon + dLon), z);
        const xs = x0 <= x1 ? [[x0, x1]] : [[x0, 2 ** z - 1], [0, x1]];
        for (const [xa, xb] of xs) {
          for (let x = xa; x <= xb; x++) {
            for (let y = lat2tile(n, z); y <= lat2tile(s, z); y++) {
              const key = `${x}/${y}`;
              if (seen.has(key)) continue;
              seen.add(key);
              tiles.push([x, y]);
            }
          }
        }
      }
    }
    out[z] = tiles;
  }
  return out;
}

// Common path for both modes: optional open-ocean filter, per-zoom counts for the dialog,
// and the download itself.
function planDownload(byZoom, { layers, coastOnly, dryRun }) {
  const ls = tileLayers(layers);
  const perZoom = {};
  const jobs = [];
  for (const [z, tiles] of Object.entries(byZoom)) {
    const kept = coastOnly === false ? tiles : tiles.filter(([x, y]) => isCoastal(+z, x, y));
    perZoom[z] = kept.length * ls.length;
    for (const [x, y] of kept) for (const layer of ls) jobs.push([layer, +z, x, y]);
  }
  if (dryRun) return { ok: true, count: jobs.length, perZoom, limit: MAX_DOWNLOAD_TILES };
  return runDownload(jobs);
}

ipcMain.handle('download-area', (_e, o) => planDownload(areaTiles(o, o.minZoom, o.maxZoom), o));

ipcMain.handle('download-corridor', (_e, o) => {
  if (!Array.isArray(o.points) || o.points.length < 2) return { ok: false, error: 'No route' };
  const radius = Math.max(1, Math.min(50, +o.radiusNm || 10));
  return planDownload(corridorTiles(o.points, radius, o.minZoom, o.maxZoom), o);
});

// Bundled offline world chart and sea-route network, see scripts/build-*.
const WORLD_LAYERS = new Set(['bathymetry', 'land', 'coastline', 'ice', 'lakes', 'rivers', 'borders', 'reefs',
  'marine-labels', 'ports', 'places', 'sea-routes', 'distance-table', 'maritime']);
ipcMain.handle('load-world-layer', (_e, name) => {
  if (!WORLD_LAYERS.has(name)) throw new Error(`unknown layer ${name}`);
  return fs.promises.readFile(path.join(__dirname, 'maps', 'world', `${name}.json`), 'utf8');
});

ipcMain.handle('get-settings', () => ({ ...settings, addresses: localAddresses(), dataDir, version: app.getVersion() }));

// QR codes the phone app scans to connect: one per network address of this computer.
ipcMain.handle('pairing-qr', () => Promise.all(localAddresses().map(async (ip) => ({
  ip,
  url: await QRCode.toDataURL(`cabingps://connect?host=${ip}&port=${settings.udpPort}`, { margin: 1, width: 240 }),
}))));

// Small JSON documents kept in the data folder (pressure history…).
const DATA_DOCS = new Set(['pressure']);
ipcMain.handle('load-data', (_e, name) => {
  if (!DATA_DOCS.has(name)) throw new Error(`unknown data ${name}`);
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8')); } catch { return null; }
});
ipcMain.handle('save-data', (_e, name, value) => {
  if (!DATA_DOCS.has(name)) throw new Error(`unknown data ${name}`);
  fs.writeFileSync(path.join(dataDir, `${name}.json`), JSON.stringify(value));
});

ipcMain.handle('copy-text', (_e, text) => clipboard.writeText(String(text).slice(0, 1000)));

ipcMain.handle('set-fullscreen', (_e, on) => {
  if (win) win.setFullScreen(!!on);
  return win ? win.isFullScreen() : false;
});

// --- Updates from GitHub Releases ---

const newer = (a, b) => {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

let updateAsset = null;

ipcMain.handle('check-update', async () => {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) return { ok: false, reason: 'private' };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => /portable\.exe$/i.test(a.name));
    updateAsset = asset || null;
    return {
      ok: true,
      current: app.getVersion(),
      latest: rel.tag_name,
      available: newer(rel.tag_name, app.getVersion()),
      page: rel.html_url,
      asset: asset ? { name: asset.name, size: asset.size } : null,
    };
  } catch {
    return { ok: false, reason: 'offline' };
  }
});

// Downloads the new portable exe next to the running one (same data folder), then can start it.
ipcMain.handle('download-update', async () => {
  const asset = updateAsset;
  const url = asset && asset.browser_download_url;
  if (!url || !url.startsWith(`https://github.com/${REPO}/releases/download/`) || !/^[\w.-]+\.exe$/.test(asset.name)) {
    return { ok: false, error: 'No update file' };
  }
  const dir = process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('downloads');
  const target = path.join(dir, asset.name);
  const res = await net.fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
  const reader = res.body.getReader();
  const out = fs.createWriteStream(target + '.part');
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    out.write(Buffer.from(value));
    send('update-progress', { got, total: asset.size });
  }
  await new Promise((r) => out.end(r));
  if (asset.size && got !== asset.size) return { ok: false, error: 'Download incomplete' };
  fs.renameSync(target + '.part', target);
  return { ok: true, path: target };
});

ipcMain.handle('launch-update', async (_e, file) => {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('downloads');
  if (path.dirname(file) !== dir || !file.endsWith('.exe') || !fs.existsSync(file)) return false;
  if (process.platform !== 'win32') {
    shell.showItemInFolder(file);
    return false;
  }
  require('child_process').spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
  return true;
});

ipcMain.handle('save-settings', (_e, next) => {
  settings = { ...settings, ...next };
  saveSettings();
  startUdp();
  startTcp();
  return settings;
});

ipcMain.handle('load-track', () => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'track.json'), 'utf8')); } catch { return []; }
});

ipcMain.handle('save-track', (_e, track) => {
  fs.writeFileSync(path.join(dataDir, 'track.json'), JSON.stringify(track));
});

ipcMain.handle('load-route', () => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'route.json'), 'utf8')); } catch { return null; }
});

ipcMain.handle('save-route', (_e, route) => {
  const file = path.join(dataDir, 'route.json');
  if (route) fs.writeFileSync(file, JSON.stringify(route));
  else fs.rmSync(file, { force: true });
});

function toGpx(track) {
  const pts = track
    .map(([lat, lon, t]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">` +
      (t ? `<time>${new Date(t).toISOString()}</time>` : '') + '</trkpt>')
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ship Cabin Chart" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Ship track</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

// Waypoints of a planned route as a GPX <rte>; sea-lane points are named but marked as such.
function routeToGpx(waypoints) {
  let n = 0;
  const pts = waypoints.map((w, i) => {
    const lon = ((((w.lon + 180) % 360) + 360) % 360) - 180;
    const name = i === 0 ? 'Start' : w.auto ? `Lane ${i}` : i === waypoints.length - 1 ? 'Destination' : `WP${++n}`;
    return `    <rtept lat="${w.lat.toFixed(6)}" lon="${lon.toFixed(6)}"><name>${name}</name></rtept>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ship Cabin Chart" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <name>Planned route</name>
${pts}
  </rte>
</gpx>
`;
}

async function saveGpx(title, name, content) {
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title,
    defaultPath: path.join(app.getPath('documents'), `${name}-${stamp}.gpx`),
    filters: [{ name: 'GPX', extensions: ['gpx'] }],
  });
  if (canceled || !filePath) return { ok: false };
  await fs.promises.writeFile(filePath, content);
  return { ok: true, path: filePath };
}

ipcMain.handle('export-gpx', (_e, track) => saveGpx('Export track', 'ship-track', toGpx(track)));
ipcMain.handle('export-route-gpx', (_e, waypoints) => saveGpx('Export route', 'ship-route', routeToGpx(waypoints)));

const cleanWaypoints = (list) => (Array.isArray(list) ? list : [])
  .filter((w) => w && Number.isFinite(w.lat) && Number.isFinite(w.lon) && Math.abs(w.lat) <= 90)
  .slice(0, 5000)
  .map((w) => ({ lat: w.lat, lon: w.lon, auto: !!w.auto, name: typeof w.name === 'string' ? w.name.slice(0, 64) : '' }));

ipcMain.handle('export-route-rtz', async (_e, waypoints, name) => {
  const wps = cleanWaypoints(waypoints);
  if (wps.length < 2) return { ok: false, error: 'The route needs at least two points' };
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export route for ECDIS (RTZ)',
    defaultPath: path.join(app.getPath('documents'), `ship-route-${stamp}.rtz`),
    filters: [{ name: 'RTZ route (IEC 61174)', extensions: ['rtz'] }],
  });
  if (canceled || !filePath) return { ok: false };
  await fs.promises.writeFile(filePath, buildRtz(wps, String(name || `Ship Cabin Chart ${stamp}`).slice(0, 80)));
  return { ok: true, path: filePath };
});

// --- S-57 ENC charts ---

const encLibrary = new EncLibrary(path.join(dataDir, 'enc'));
let encBusy = false;

ipcMain.handle('enc-list', () => encLibrary.list());
ipcMain.handle('enc-catalogue', () => fs.promises.readFile(path.join(__dirname, 's57', 'catalogue.json'), 'utf8'));
ipcMain.handle('enc-load', (_e, name) => encLibrary.load(String(name)));
ipcMain.handle('enc-remove', (_e, names) => encLibrary.remove((Array.isArray(names) ? names : []).map(String)));
ipcMain.handle('enc-import', async (_e, kind) => {
  if (encBusy) return { ok: false, error: 'An import is already running' };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, kind === 'folder'
    ? { title: 'Import ENC charts: choose a folder (e.g. ENC_ROOT)', properties: ['openDirectory'] }
    : {
      title: 'Import ENC charts (S-57 .000 cells or .zip)',
      filters: [{ name: 'S-57 ENC', extensions: ['000', 'zip'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile', 'multiSelections'],
    });
  if (canceled || !filePaths.length) return { ok: false };
  encBusy = true;
  try {
    const results = await encLibrary.import(filePaths, (p) => win && win.webContents.send('enc-progress', p));
    if (!results.length) return { ok: false, error: 'No S-57 cells (.000 files) were found there' };
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    encBusy = false;
  }
});

ipcMain.handle('import-route', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import route (RTZ from ECDIS, or GPX)',
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'Routes', extensions: ['rtz', 'gpx', 'xml'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  const file = filePaths[0];
  try {
    const { size } = await fs.promises.stat(file);
    if (size > 20 * 1024 * 1024) throw new Error('The file is too large for a route');
    const route = parseRouteFile(await fs.promises.readFile(file), file);
    return { ok: true, file: path.basename(file), ...route };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#02060d',
    title: 'Ship Cabin Chart',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    minWidth: 900,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The app only ever shows its own page: no pop-ups, no navigation away.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    startUdp();
    startTcp();
  });
}

app.whenReady().then(() => {
  registerTileProtocol();
  createWindow();
});

app.on('window-all-closed', () => {
  if (udpSocket) udpSocket.close();
  if (tcpClient) tcpClient.destroy();
  app.quit();
});
