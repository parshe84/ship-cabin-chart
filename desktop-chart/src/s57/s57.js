'use strict';

// IHO S-57 Edition 3.1 ENC cell reader: base cell (.000) plus sequential updates (.001, .002 ...),
// converted to GeoJSON features for drawing. Topology (nodes, edges) is resolved into plain
// geometry; area outlines keep only the edges that are not masked or at the data limit.

const { readDdr, records, parseField } = require('./iso8211');
const catalogue = require('./catalogue.json');

const RCNM = { DS: 10, DP: 20, FE: 100, VI: 110, VC: 120, VE: 130, VF: 140 };
const DELETE_VALUE = '\x7f';

const nameKey = (b) => `${b[0]}:${b.readUInt32LE(1)}`;

function readFile(buf) {
  const ddr = readDdr(buf);
  const out = { dsid: null, dssi: null, dspm: null, vectors: [], features: [] };
  let wide = false;
  for (const fields of records(buf, ddr)) {
    const rec = {};
    for (const { tag, data } of fields) {
      const def = ddr.defs[tag];
      if (!def || tag === '0001') continue;
      const value = parseField(def, data, tag === 'NATF' && wide);
      // A tag can repeat within a record (e.g. several FSPT fields): concatenate their rows.
      if (rec[tag] && Array.isArray(rec[tag])) rec[tag] = rec[tag].concat(value);
      else rec[tag] = value;
    }
    if (rec.DSID) {
      out.dsid = rec.DSID;
      out.dssi = rec.DSSI || null;
      wide = !!(rec.DSSI && rec.DSSI.NALL === 2);
    } else if (rec.DSPM) out.dspm = rec.DSPM;
    else if (rec.VRID) out.vectors.push(rec);
    else if (rec.FRID) out.features.push(rec);
  }
  if (!out.dsid) throw new Error('Not an S-57 ENC cell: no data set identification record');
  return out;
}

function attrMap(rows) {
  const out = {};
  for (const r of rows || []) {
    const def = catalogue.attributes[r.ATTL];
    out[def ? def[0] : `ATTL${r.ATTL}`] = r.ATVL;
  }
  return out;
}

function applyAttrs(target, rows) {
  for (const [k, v] of Object.entries(attrMap(rows))) {
    if (v === DELETE_VALUE) delete target[k];
    else target[k] = v;
  }
}

const pointer = (r) => ({ key: nameKey(r.NAME), ornt: r.ORNT, usag: r.USAG, topi: r.TOPI, mask: r.MASK });

// Insert / delete / modify a run of list entries, as S-57 update instructions do.
function editList(list, ui, ix, n, items) {
  const at = Math.max(0, ix - 1);
  if (ui === 1) list.splice(at, 0, ...items);
  else if (ui === 2) list.splice(at, n);
  else if (ui === 3) list.splice(at, items.length, ...items);
}

class Cell {
  constructor() {
    this.vectors = new Map();
    this.features = new Map();
  }

  loadBase(buf) {
    const f = readFile(buf);
    this.dsid = f.dsid;
    this.dspm = f.dspm || {};
    this.comf = this.dspm.COMF || 10000000;
    this.somf = this.dspm.SOMF || 10;
    this.updn = Number(f.dsid.UPDN) || 0;
    this.apply(f, true);
  }

  // Applies an update file; returns false if it does not follow the current update number.
  loadUpdate(buf) {
    const f = readFile(buf);
    const n = Number(f.dsid.UPDN);
    if (n !== this.updn + 1) return false;
    if (Number(f.dsid.EDTN) === 0) this.cancelled = true;
    this.apply(f, false);
    this.updn = n;
    if (f.dsid.UADT) this.dsid.UADT = f.dsid.UADT;
    return true;
  }

  apply(f, base) {
    for (const r of f.vectors) {
      const id = r.VRID;
      const key = `${id.RCNM}:${id.RCID}`;
      const ruin = base ? 1 : id.RUIN;
      if (ruin === 2) { this.vectors.delete(key); continue; }
      if (ruin === 1) {
        this.vectors.set(key, {
          rcnm: id.RCNM,
          attrs: attrMap(r.ATTV),
          ptrs: (r.VRPT || []).map(pointer),
          sg2d: (r.SG2D || []).map((p) => [p.XCOO, p.YCOO]),
          sg3d: (r.SG3D || []).map((p) => [p.XCOO, p.YCOO, p.VE3D]),
        });
        continue;
      }
      const v = this.vectors.get(key);
      if (!v) continue;
      if (r.ATTV) applyAttrs(v.attrs, r.ATTV);
      if (r.VRPC) editList(v.ptrs, r.VRPC.VPUI, r.VRPC.VPIX, r.VRPC.NVPT, (r.VRPT || []).map(pointer));
      if (r.SGCC) {
        const { CCUI, CCIX, CCNC } = r.SGCC;
        if (r.SG3D) editList(v.sg3d, CCUI, CCIX, CCNC, r.SG3D.map((p) => [p.XCOO, p.YCOO, p.VE3D]));
        else editList(v.sg2d, CCUI, CCIX, CCNC, (r.SG2D || []).map((p) => [p.XCOO, p.YCOO]));
      }
    }
    for (const r of f.features) {
      const id = r.FRID;
      const key = `${id.RCNM}:${id.RCID}`;
      const ruin = base ? 1 : id.RUIN;
      if (ruin === 2) { this.features.delete(key); continue; }
      if (ruin === 1) {
        this.features.set(key, {
          rcid: id.RCID,
          prim: id.PRIM,
          objl: id.OBJL,
          foid: r.FOID ? `${r.FOID.AGEN}-${r.FOID.FIDN}-${r.FOID.FIDS}` : null,
          attrs: attrMap(r.ATTF),
          nattrs: attrMap(r.NATF),
          fspt: (r.FSPT || []).map(pointer),
        });
        continue;
      }
      const ft = this.features.get(key);
      if (!ft) continue;
      if (r.ATTF) applyAttrs(ft.attrs, r.ATTF);
      if (r.NATF) applyAttrs(ft.nattrs, r.NATF);
      if (r.FSPC) editList(ft.fspt, r.FSPC.FSUI, r.FSPC.FSIX, r.FSPC.NSPT, (r.FSPT || []).map(pointer));
    }
  }

  coord(p) {
    // 1e-7° (about 1 cm) is the finest resolution ENCs are compiled at.
    return [Math.round((p[0] / this.comf) * 1e7) / 1e7, Math.round((p[1] / this.comf) * 1e7) / 1e7];
  }

  nodeCoord(key) {
    const n = this.vectors.get(key);
    if (!n) return null;
    if (n.sg2d.length) return this.coord(n.sg2d[0]);
    if (n.sg3d.length) return this.coord(n.sg3d[0]);
    return null;
  }

  // Edge as a coordinate list from its begin node to its end node.
  edgeCoords(key) {
    const e = this.vectors.get(key);
    if (!e) return null;
    const begin = e.ptrs.find((p) => p.topi === 1) || e.ptrs[0];
    const end = e.ptrs.find((p) => p.topi === 2) || e.ptrs[1];
    const pts = e.sg2d.map((p) => this.coord(p));
    const a = begin && this.nodeCoord(begin.key);
    const b = end && this.nodeCoord(end.key);
    if (a) pts.unshift(a);
    if (b) pts.push(b);
    return pts.length >= 2 ? pts : null;
  }

  orientedEdges(ptrs, keep) {
    const out = [];
    for (const p of ptrs) {
      if (keep && !keep(p)) continue;
      const c = this.edgeCoords(p.key);
      if (c) out.push(p.ornt === 2 ? c.slice().reverse() : c);
    }
    return out;
  }

  geometry(ft) {
    if (ft.prim === 1) {
      const p = ft.fspt[0];
      const n = p && this.vectors.get(p.key);
      if (!n) return null;
      if (n.sg3d.length) {
        return { type: 'MultiPoint', coordinates: n.sg3d.map((q) => [...this.coord(q), Math.round((q[2] / this.somf) * 100) / 100]) };
      }
      const c = this.nodeCoord(p.key);
      return c && { type: 'Point', coordinates: c };
    }
    if (ft.prim === 2) {
      const lines = chain(this.orientedEdges(ft.fspt, (p) => p.mask !== 1));
      if (!lines.length) return null;
      return lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };
    }
    if (ft.prim === 3) {
      const rings = chain(this.orientedEdges(ft.fspt)).filter((r) => r.length >= 4);
      if (!rings.length) return null;
      for (const r of rings) {
        const a = r[0], b = r[r.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) r.push(a);
      }
      return { type: 'Polygon', coordinates: rings };
    }
    return null;
  }

  // Area boundary without masked edges and edges on the data limit (null = draw the whole outline).
  outline(ft) {
    if (!ft.fspt.some((p) => p.mask === 1 || p.usag === 3)) return null;
    const lines = chain(this.orientedEdges(ft.fspt, (p) => p.mask !== 1 && p.usag !== 3));
    return { type: 'MultiLineString', coordinates: lines };
  }

  info() {
    const d = this.dsid;
    return {
      name: String(d.DSNM || '').replace(/\.000$/i, ''),
      band: Number(d.INTU) || 0,
      edition: Number(d.EDTN) || 0,
      update: this.updn,
      issued: d.UADT || d.ISDT || '',
      agency: d.AGEN,
      scale: this.dspm.CSCL || null,
      comment: d.COMT || '',
      cancelled: !!this.cancelled,
    };
  }

  // GeoJSON features: properties { c: class acronym, a: attributes, n: national attributes, id }.
  toGeoJSON() {
    const features = [];
    let w = 180, s = 90, e = -180, n = -90;
    const grow = (c) => {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    };
    for (const ft of this.features.values()) {
      const def = catalogue.classes[ft.objl];
      const c = def ? def[0] : `OBJL${ft.objl}`;
      const geometry = this.geometry(ft);
      if (!geometry) continue;
      const properties = { c, a: ft.attrs, id: ft.rcid };
      if (Object.keys(ft.nattrs).length) properties.n = ft.nattrs;
      if (c === 'M_COVR' && ft.attrs.CATCOV !== '2') {
        geometry.coordinates.forEach((r) => r.forEach(grow));
      }
      if (ft.prim === 3) {
        const o = this.outline(ft);
        if (o) {
          properties.ns = 1; // no stroke on the polygon itself
          if (o.coordinates.length) features.push({ type: 'Feature', geometry: o, properties: { c, a: ft.attrs, id: ft.rcid, ol: 1 } });
        }
      }
      features.push({ type: 'Feature', geometry, properties });
    }
    if (w > e) {
      // No coverage record: use the extent of all geometry.
      for (const f of features) flatten(f.geometry).forEach(grow);
    }
    return { type: 'FeatureCollection', bbox: [w, s, e, n], features };
  }
}

function flatten(g) {
  if (g.type === 'Point') return [g.coordinates];
  if (g.type === 'MultiPoint' || g.type === 'LineString') return g.coordinates;
  return g.coordinates.flat(1);
}

const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];

// Joins oriented edges into lines/rings. S-57 lists the edges of a boundary in order, so they
// are first joined in sequence; pieces that still do not close are then matched by end points.
function chain(edges) {
  const pieces = [];
  let line = null;
  for (const e of edges) {
    if (line && same(line[line.length - 1], e[0]) && !(line.length > 2 && same(line[0], line[line.length - 1]))) {
      for (let i = 1; i < e.length; i++) line.push(e[i]);
    } else {
      if (line) pieces.push(line);
      line = e.slice();
    }
  }
  if (line) pieces.push(line);
  const closed = (l) => l.length > 2 && same(l[0], l[l.length - 1]);
  const out = pieces.filter(closed);
  const left = pieces.filter((l) => !closed(l));
  while (left.length) {
    let cur = left.shift();
    let grown = true;
    while (grown && !closed(cur)) {
      grown = false;
      // Prefer joins that keep the edge direction, then reversed ones.
      for (const pass of [0, 1]) {
        for (let i = 0; i < left.length && !grown; i++) {
          const e = left[i];
          if (pass === 0 && same(e[0], cur[cur.length - 1])) cur = cur.concat(e.slice(1));
          else if (pass === 0 && same(e[e.length - 1], cur[0])) cur = e.slice(0, -1).concat(cur);
          else if (pass === 1 && same(e[e.length - 1], cur[cur.length - 1])) cur = cur.concat(e.slice(0, -1).reverse());
          else if (pass === 1 && same(e[0], cur[0])) cur = e.slice(1).reverse().concat(cur);
          else continue;
          left.splice(i, 1);
          grown = true;
        }
        if (grown) break;
      }
    }
    out.push(cur);
  }
  return out;
}

// base: Buffer of the .000 file; updates: Buffers of .001, .002 ... in any order.
function readCell(base, updates = []) {
  const cell = new Cell();
  cell.loadBase(base);
  const pending = updates.map((b) => {
    try {
      return readFile(b) && b;
    } catch {
      return null;
    }
  }).filter(Boolean);
  // Apply in update-number order; stop at the first gap.
  let progress = true;
  while (progress && pending.length) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      if (cell.loadUpdate(pending[i])) {
        pending.splice(i, 1);
        progress = true;
        break;
      }
    }
  }
  return cell;
}

module.exports = { readCell, RCNM, catalogue };
