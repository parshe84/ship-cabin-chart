'use strict';

const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const tcp = require('net');
const os = require('os');
const { parseSentence } = require('./nmea');

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
const USER_AGENT = 'ShipCabinChart/0.1 (+https://github.com/parshe84/ship-cabin-chart)';

const defaultSettings = { udpPort: 10110, tcpHost: '', tcpPort: 10110, follow: true };
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

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function handleData(chunk, source) {
  lineBuffer += chunk.toString('ascii');
  const lines = lineBuffer.split(/\r?\n/);
  lineBuffer = lines.pop();
  for (const line of lines) {
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

ipcMain.handle('download-area', async (_e, { north, south, east, west, minZoom, maxZoom, layers }) => {
  const jobs = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    for (let x = lon2tile(west, z); x <= lon2tile(east, z); x++) {
      for (let y = lat2tile(north, z); y <= lat2tile(south, z); y++) {
        for (const layer of layers) jobs.push([layer, z, x, y]);
      }
    }
  }
  if (jobs.length > MAX_DOWNLOAD_TILES) {
    return { ok: false, error: `Too many tiles (${jobs.length}). Zoom in or lower the max zoom (limit ${MAX_DOWNLOAD_TILES}).` };
  }
  let done = 0, failed = 0;
  const workers = Array.from({ length: 2 }, async () => {
    while (jobs.length) {
      const [layer, z, x, y] = jobs.shift();
      try { await fetchTile(layer, z, x, y); } catch { failed++; }
      done++;
      if (done % 10 === 0) send('download-progress', { done, failed });
    }
  });
  await Promise.all(workers);
  return { ok: true, done, failed };
});

// Bundled offline world chart (Natural Earth), see scripts/build-world-map.js.
const WORLD_LAYERS = new Set(['bathymetry', 'land', 'coastline', 'ice', 'lakes', 'rivers', 'borders', 'reefs',
  'marine-labels', 'ports', 'places']);
ipcMain.handle('load-world-layer', (_e, name) => {
  if (!WORLD_LAYERS.has(name)) throw new Error(`unknown layer ${name}`);
  return fs.promises.readFile(path.join(__dirname, 'maps', 'world', `${name}.json`), 'utf8');
});

ipcMain.handle('get-settings', () => ({ ...settings, addresses: localAddresses(), dataDir }));

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

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0b1d2e',
    title: 'Ship Cabin Chart',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
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
