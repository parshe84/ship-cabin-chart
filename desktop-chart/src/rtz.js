// Route exchange with ECDIS: RTZ (IEC 61174, versions 1.0/1.1/1.2) import and export, plus GPX import.
// Parsing is tolerant: namespace prefixes, attribute order, single/double quotes and UTF-16 files are accepted.

function decodeText(buf) {
  if (typeof buf === 'string') return buf.replace(/^﻿/, '');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^﻿/, '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] ?? m;
});
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`);

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1].replace(/^\w+:/, '')] = unescapeXml(m[3] ?? m[4]);
  }
  return out;
}

// Each element <tag ...>body</tag> or <tag .../> with any namespace prefix.
function elements(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>)`, 'g');
  return [...xml.matchAll(re)].map((m) => ({ attrs: attrs(m[1]), body: m[3] || '' }));
}

const num = (v) => (v == null || v.trim() === '' ? NaN : Number(v));
const validPoint = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

function parseRtz(input) {
  const xml = decodeText(input).replace(/<!--[\s\S]*?-->/g, '');
  const info = elements(xml, 'routeInfo')[0];
  const route = elements(xml, 'route')[0];
  const name = (info && info.attrs.routeName) || (route && route.attrs.routeName) || '';
  const waypoints = [];
  for (const w of elements(xml, 'waypoint')) {
    const pos = elements(w.body, 'position')[0];
    if (!pos) continue;
    const lat = num(pos.attrs.lat);
    const lon = num(pos.attrs.lon);
    if (!validPoint(lat, lon)) throw new Error(`Waypoint ${w.attrs.id || waypoints.length + 1} has an invalid position`);
    waypoints.push({ lat, lon, name: w.attrs.name || '' });
  }
  if (waypoints.length < 2) throw new Error('No route found: an RTZ route needs at least two <waypoint> elements');
  return { name, waypoints };
}

function parseGpxRoute(input) {
  const xml = decodeText(input).replace(/<!--[\s\S]*?-->/g, '');
  const rte = elements(xml, 'rte')[0];
  const source = rte ? rte.body : xml;
  let pts = elements(source, 'rtept');
  if (!rte && !pts.length) pts = elements(xml, 'trkpt');
  const outer = (rte ? rte.body : xml).replace(/<(?:\w+:)?(rtept|trkpt|wpt|metadata)\b[\s\S]*?<\/(?:\w+:)?\1\s*>/g, '');
  const nameEl = elements(outer, 'name')[0];
  const waypoints = pts.map((p) => {
    const lat = num(p.attrs.lat);
    const lon = num(p.attrs.lon);
    if (!validPoint(lat, lon)) throw new Error('A GPX point has an invalid position');
    const n = elements(p.body, 'name')[0];
    return { lat, lon, name: n ? unescapeXml(n.body.trim()) : '' };
  });
  if (waypoints.length < 2) throw new Error('No route found in the GPX file');
  return { name: nameEl ? unescapeXml(nameEl.body.trim()) : '', waypoints };
}

function parseRouteFile(input, fileName = '') {
  const text = decodeText(input);
  if (/\.gpx$/i.test(fileName) || (/<(?:\w+:)?gpx\b/.test(text) && !/<(?:\w+:)?route\b/.test(text))) return parseGpxRoute(text);
  return parseRtz(text);
}

const wrap180 = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// RTZ 1.0, the version every ECDIS accepts. Legs are rhumb lines, as planned in this app.
function buildRtz(waypoints, routeName = 'Ship Cabin Chart route') {
  let n = 0;
  const wps = waypoints.map((w, i) => {
    const name = w.name || (i === 0 ? 'Start' : i === waypoints.length - 1 ? 'Destination' : w.auto ? `Lane ${i}` : `WP${++n}`);
    const leg = i === 0 ? '' : '\n      <leg geometryType="Loxodrome"/>';
    return `    <waypoint id="${i + 1}" name="${escapeXml(name)}">
      <position lat="${w.lat.toFixed(6)}" lon="${wrap180(w.lon).toFixed(6)}"/>${leg}
    </waypoint>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<route xmlns="http://www.cirm.org/RTZ/1/0" version="1.0">
  <routeInfo routeName="${escapeXml(routeName)}"/>
  <waypoints>
${wps}
  </waypoints>
</route>
`;
}

module.exports = { parseRtz, parseGpxRoute, parseRouteFile, buildRtz };
