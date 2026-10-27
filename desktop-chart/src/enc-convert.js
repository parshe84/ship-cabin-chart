'use strict';

// Converts one S-57 cell (base + updates) to a GeoJSON file; returns its library entry.

const fs = require('fs');
const { readCell } = require('./s57/s57');

function convertCell(base, updates, out) {
  const cell = readCell(Buffer.from(base), updates.map((u) => Buffer.from(u)));
  const info = cell.info();
  if (info.cancelled) throw new Error('This cell has been cancelled by its producer');
  const geo = cell.toGeoJSON();
  if (!geo.features.length) throw new Error('The cell has no chart features');
  fs.writeFileSync(out, JSON.stringify(geo));
  return { ...info, bbox: geo.bbox, features: geo.features.length, size: fs.statSync(out).size };
}

module.exports = { convertCell };
