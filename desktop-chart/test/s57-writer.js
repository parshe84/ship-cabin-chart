'use strict';

// Minimal ISO 8211 / S-57 writer used only by the tests to build small ENC cells and updates.

const FT = 0x1e, UT = 0x1f;

const FIELDS = {
  '0001': ['0100;&   ', 'ISO/IEC 8211 Record Identifier', '', '(b12)'],
  DSID: ['1600;&   ', 'Data set identification field', 'RCNM!RCID!EXPP!INTU!DSNM!EDTN!UPDN!UADT!ISDT!STED!PRSP!PSDN!PRED!PROF!AGEN!COMT', '(b11,b14,2b11,3A,2A(8),R(4),b11,2A,b11,b12,A)'],
  DSSI: ['1600;&   ', 'Data set structure information field', 'DSTR!AALL!NALL!NOMR!NOCR!NOGR!NOLR!NOIN!NOCN!NOED!NOFA', '(3b11,8b14)'],
  DSPM: ['1600;&   ', 'Data set parameter field', 'RCNM!RCID!HDAT!VDAT!SDAT!CSCL!DUNI!HUNI!PUNI!COUN!COMF!SOMF!COMT', '(b11,b14,3b11,b14,4b11,2b14,A)'],
  VRID: ['1600;&   ', 'Vector record identifier field', 'RCNM!RCID!RVER!RUIN', '(b11,b14,b12,b11)'],
  ATTV: ['2600;&   ', 'Vector record attribute field', '*ATTL!ATVL', '(b12,A)'],
  VRPC: ['1600;&   ', 'Vector record pointer control field', 'VPUI!VPIX!NVPT', '(b11,2b12)'],
  VRPT: ['2600;&   ', 'Vector record pointer field', '*NAME!ORNT!USAG!TOPI!MASK', '(B(40),4b11)'],
  SGCC: ['1600;&   ', 'Coordinate control field', 'CCUI!CCIX!CCNC', '(b11,2b12)'],
  SG2D: ['2500;&   ', '2-D coordinate field', '*YCOO!XCOO', '(2b24)'],
  SG3D: ['2500;&   ', '3-D coordinate field', '*YCOO!XCOO!VE3D', '(3b24)'],
  FRID: ['1600;&   ', 'Feature record identifier field', 'RCNM!RCID!PRIM!GRUP!OBJL!RVER!RUIN', '(b11,b14,2b11,2b12,b11)'],
  FOID: ['1600;&   ', 'Feature object identifier field', 'AGEN!FIDN!FIDS', '(b12,b14,b12)'],
  ATTF: ['2600;&   ', 'Feature record attribute field', '*ATTL!ATVL', '(b12,A)'],
  FSPC: ['1600;&   ', 'Feature record to spatial record pointer control field', 'FSUI!FSIX!NSPT', '(b11,2b12)'],
  FSPT: ['2600;&   ', 'Feature record to spatial record pointer field', '*NAME!ORNT!USAG!MASK', '(B(40),3b11)'],
};

const { expandFormat } = require('../src/s57/iso8211');

function encodeField(tag, rows) {
  const [, , desc, fmt] = FIELDS[tag];
  const labels = desc.replace('*', '').split('!');
  const formats = expandFormat(fmt);
  const parts = [];
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    labels.forEach((l, i) => {
      const f = formats[i];
      const v = row[l];
      if (f.type === 'u' || f.type === 's') {
        const b = Buffer.alloc(f.width);
        if (f.width === 1) b[0] = v & 0xff;
        else if (f.width === 2) (f.type === 'u' ? b.writeUInt16LE(v) : b.writeInt16LE(v));
        else (f.type === 'u' ? b.writeUInt32LE(v >>> 0) : b.writeInt32LE(v));
        parts.push(b);
      } else if (f.type === 'B') {
        parts.push(v);
      } else if (f.width) {
        parts.push(Buffer.from(String(v ?? '').padEnd(f.width).slice(0, f.width), 'latin1'));
      } else {
        parts.push(Buffer.from(String(v ?? ''), 'latin1'), Buffer.from([UT]));
      }
    });
  }
  parts.push(Buffer.from([FT]));
  return Buffer.concat(parts);
}

function record(leaderFn, fields) {
  const sizeLen = 5, sizePos = 5, sizeTag = 4;
  let pos = 0;
  const dir = [];
  for (const [tag, data] of fields) {
    dir.push(tag + String(data.length).padStart(sizeLen, '0') + String(pos).padStart(sizePos, '0'));
    pos += data.length;
  }
  const dirBuf = Buffer.concat([Buffer.from(dir.join(''), 'latin1'), Buffer.from([FT])]);
  const base = 24 + dirBuf.length;
  const len = base + pos;
  const leader = Buffer.from(leaderFn(len, base, `${sizeLen}${sizePos}0${sizeTag}`), 'latin1');
  return Buffer.concat([leader, dirBuf, ...fields.map((f) => f[1])]);
}

function ddr() {
  const fields = [['0000', Buffer.concat([Buffer.from('0000;&   test', 'latin1'), Buffer.from([FT])])]];
  for (const [tag, [ctl, name, desc, fmt]] of Object.entries(FIELDS)) {
    fields.push([tag, Buffer.concat([Buffer.from(`${ctl}${name}`, 'latin1'), Buffer.from([UT]),
      Buffer.from(desc, 'latin1'), Buffer.from([UT]), Buffer.from(fmt, 'latin1'), Buffer.from([FT])])]);
  }
  return record((len, base, map) => `${String(len).padStart(5, '0')}3LE1 09${String(base).padStart(5, '0')} ! ${map}`, fields);
}

let seq = 1;
function dr(fields) {
  const all = [['0001', encodeField('0001', { '': seq++ })], ...fields.map(([t, v]) => [t, encodeField(t, v)])];
  return record((len, base, map) => `${String(len).padStart(5, '0')} D     ${String(base).padStart(5, '0')}   ${map}`, all);
}
FIELDS['0001'][2] = '';

function name(rcnm, rcid) {
  const b = Buffer.alloc(5);
  b[0] = rcnm;
  b.writeUInt32LE(rcid, 1);
  return b;
}

// records: arrays of [tag, value] fields. Returns a file Buffer.
function file(records) {
  return Buffer.concat([ddr(), ...records.map(dr)]);
}

module.exports = { file, name };
