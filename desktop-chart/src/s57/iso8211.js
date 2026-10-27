'use strict';

// ISO/IEC 8211 reader: the container format of IHO S-57 ENC files.
// A file is a Data Descriptive Record (field definitions) followed by Data Records.

const FT = 0x1e; // field terminator
const UT = 0x1f; // unit (subfield) terminator

const int = (buf, start, len) => parseInt(buf.toString('latin1', start, start + len), 10);

// "(b11,2b12,A(2),3A,(b24,b24))" -> [{ type, width }]
function expandFormat(fmt) {
  let s = fmt.trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  const items = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  items.push(cur);
  const out = [];
  for (let it of items) {
    it = it.trim();
    if (!it) continue;
    const m = /^(\d+)(\D.*)$/.exec(it);
    const rep = m ? Number(m[1]) : 1;
    const body = m ? m[2] : it;
    const parts = body.startsWith('(') ? expandFormat(body) : [parseItem(body)];
    for (let i = 0; i < rep; i++) out.push(...parts);
  }
  return out;
}

function parseItem(s) {
  let m = /^b([12])(\d)$/.exec(s);
  if (m) return { type: m[1] === '1' ? 'u' : 's', width: Number(m[2]) };
  m = /^B\((\d+)\)$/.exec(s);
  if (m) return { type: 'B', width: Number(m[1]) / 8 };
  m = /^([AIR])(?:\((\d+)\))?$/.exec(s);
  if (m) return { type: m[1], width: m[2] ? Number(m[2]) : 0 };
  throw new Error(`Unsupported ISO 8211 format "${s}"`);
}

function readDirectory(buf, start, leader) {
  const { sizeLen, sizePos, sizeTag, base } = leader;
  const entry = sizeLen + sizePos + sizeTag;
  const dir = [];
  for (let p = start; buf[p] !== FT && p + entry <= start + base; p += entry) {
    dir.push({
      tag: buf.toString('latin1', p, p + sizeTag),
      len: int(buf, p + sizeTag, sizeLen),
      pos: int(buf, p + sizeTag + sizeLen, sizePos),
    });
  }
  return dir;
}

function readLeader(buf, at) {
  if (at + 24 > buf.length) throw new Error('Truncated ISO 8211 record');
  return {
    length: int(buf, at, 5),
    base: int(buf, at + 12, 5),
    sizeLen: int(buf, at + 20, 1),
    sizePos: int(buf, at + 21, 1),
    sizeTag: int(buf, at + 23, 1),
  };
}

function readDdr(buf) {
  // Leader byte 6 is 'L' in every DDR; an encrypted S-63 cell is random bytes.
  if (buf.length < 24 || buf[6] !== 0x4c || !/^\d{5}$/.test(buf.toString('latin1', 0, 5))) {
    throw new Error('Not an S-57 ENC file (encrypted S-63 cells cannot be opened)');
  }
  const leader = readLeader(buf, 0);
  const fcl = int(buf, 10, 2);
  const defs = {};
  for (const d of readDirectory(buf, 24, leader)) {
    const start = leader.base + d.pos;
    const body = buf.subarray(start, start + d.len);
    if (d.tag === '0000') continue;
    const text = body.toString('latin1', fcl, body.length - 1);
    const [name, descriptor = '', format = ''] = text.split(String.fromCharCode(UT));
    const repeatAt = descriptor.indexOf('*');
    const labels = descriptor.replace('*', '').split('!').filter(Boolean);
    const before = repeatAt <= 0 ? 0 : descriptor.slice(0, repeatAt).split('!').filter(Boolean).length;
    defs[d.tag] = {
      tag: d.tag,
      name,
      labels,
      repeatFrom: repeatAt < 0 ? -1 : before,
      formats: format ? expandFormat(format) : [],
    };
  }
  return { defs, next: leader.length };
}

// Reads one subfield; `wide` = UCS-2 strings (S-57 lexical level 2, used by NATF).
function readValue(data, pos, f, wide) {
  if (f.width) {
    const end = pos + f.width;
    switch (f.type) {
      case 'u': return [f.width === 1 ? data[pos] : f.width === 2 ? data.readUInt16LE(pos) : data.readUInt32LE(pos), end];
      case 's': return [f.width === 1 ? data.readInt8(pos) : f.width === 2 ? data.readInt16LE(pos) : data.readInt32LE(pos), end];
      case 'B': return [data.subarray(pos, end), end];
      case 'A': return [data.toString('latin1', pos, end), end];
      default: return [Number(data.toString('latin1', pos, end)), end];
    }
  }
  let end = pos;
  if (wide) {
    while (end + 1 < data.length && !((data[end] === UT || data[end] === FT) && data[end + 1] === 0)) end += 2;
    return [data.toString('utf16le', pos, end), Math.min(data.length, end + 2)];
  }
  while (end < data.length && data[end] !== UT && data[end] !== FT) end++;
  const s = data.toString('latin1', pos, end);
  return [f.type === 'A' ? s : s === '' ? null : Number(s), data[end] === UT ? end + 1 : end];
}

// Returns an object (no repeating group) or an array of objects (repeating group; the
// non-repeating subfields before it are copied into each element).
function parseField(def, data, wide) {
  const { labels, formats, repeatFrom } = def;
  const fmt = (i) => formats[Math.min(i, formats.length - 1)] || { type: 'A', width: 0 };
  let pos = 0;
  const head = {};
  const stop = repeatFrom < 0 ? labels.length : repeatFrom;
  for (let i = 0; i < stop; i++) [head[labels[i]], pos] = readValue(data, pos, fmt(i), wide);
  if (repeatFrom < 0) return head;
  const rows = [];
  // Only the trailing field terminator ends the group: binary values may contain 0x1e.
  const atEnd = () => {
    const rest = data.length - pos;
    return rest <= 0 || (rest <= (wide ? 2 : 1) && data[pos] === FT);
  };
  while (!atEnd()) {
    const row = { ...head };
    for (let i = repeatFrom; i < labels.length; i++) [row[labels[i]], pos] = readValue(data, pos, fmt(i), wide);
    rows.push(row);
  }
  return rows;
}

// Iterates the data records: each is an array of { tag, data } with raw field bytes.
function* records(buf, ddr) {
  let at = ddr.next;
  while (at + 24 <= buf.length) {
    const leader = readLeader(buf, at);
    if (!(leader.length > 0)) break;
    const fields = readDirectory(buf, at + 24, leader).map((d) => {
      const start = at + leader.base + d.pos;
      return { tag: d.tag, data: buf.subarray(start, start + d.len) };
    });
    yield fields;
    at += leader.length;
  }
}

module.exports = { readDdr, records, parseField, expandFormat };
