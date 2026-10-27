const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readCell } = require('../src/s57/s57');
const { file, name } = require('./s57-writer');

const COMF = 10000000;
const xy = (lon, lat) => ({ YCOO: Math.round(lat * COMF), XCOO: Math.round(lon * COMF) });
const dsid = (updn, extra = {}) => ['DSID', {
  RCNM: 10, RCID: 1, EXPP: updn ? 2 : 1, INTU: 5, DSNM: 'XX5TEST.000', EDTN: '3', UPDN: String(updn),
  UADT: `2026010${updn + 1}`, ISDT: '20260101', STED: '03.1', PRSP: 1, PSDN: '', PRED: '2.0', PROF: 1, AGEN: 550, COMT: '', ...extra,
}];
const dssi = ['DSSI', { DSTR: 2, AALL: 1, NALL: 1, NOMR: 0, NOCR: 0, NOGR: 0, NOLR: 0, NOIN: 0, NOCN: 0, NOED: 0, NOFA: 0 }];
const dspm = ['DSPM', { RCNM: 20, RCID: 1, HDAT: 2, VDAT: 17, SDAT: 23, CSCL: 22000, DUNI: 1, HUNI: 1, PUNI: 1, COUN: 1, COMF, SOMF: 10, COMT: '' }];
const vrid = (rcnm, rcid, ruin = 1) => ['VRID', { RCNM: rcnm, RCID: rcid, RVER: 1, RUIN: ruin }];
const frid = (rcid, prim, objl, ruin = 1) => ['FRID', { RCNM: 100, RCID: rcid, PRIM: prim, GRUP: 2, OBJL: objl, RVER: 1, RUIN: ruin }];
const foid = (n) => ['FOID', { AGEN: 550, FIDN: n, FIDS: 1 }];
const ptr = (rcnm, rcid, o = {}) => ({ NAME: name(rcnm, rcid), ORNT: 255, USAG: 255, TOPI: 255, MASK: 255, ...o });

// A square depth area (4 connected nodes, 4 edges; one edge has an extra vertex and a value
// containing the byte 0x1e), a lateral buoy, and two soundings.
function baseCell() {
  const corners = [[10, 50], [10.1, 50], [10.1, 50.1], [10, 50.1]];
  const recs = [[dsid(0), dssi], [dspm]];
  corners.forEach((c, i) => recs.push([vrid(120, i + 1), ['SG2D', [xy(...c)]]]));
  for (let i = 0; i < 4; i++) {
    const r = [vrid(130, i + 1), ['VRPT', [ptr(120, i + 1, { TOPI: 1 }), ptr(120, ((i + 1) % 4) + 1, { TOPI: 2 })]]];
    if (i === 0) r.push(['SG2D', [{ YCOO: 500000030, XCOO: 100500000 }]]); // 0x1e byte inside the value
    recs.push(r);
  }
  recs.push([vrid(110, 1), ['SG2D', [xy(10.05, 50.05)]]]);
  recs.push([vrid(110, 2), ['SG3D', [{ ...xy(10.02, 50.02), VE3D: 123 }, { ...xy(10.03, 50.03), VE3D: 45 }]]]);
  recs.push([frid(1, 3, 42), foid(1), ['ATTF', [{ ATTL: 87, ATVL: '5' }, { ATTL: 88, ATVL: '10' }]],
    ['FSPT', [1, 2, 3, 4].map((e) => ptr(130, e, { ORNT: 1, USAG: 1, MASK: e === 3 ? 1 : 255 }))]]);
  recs.push([frid(2, 1, 17), foid(2), ['ATTF', [{ ATTL: 75, ATVL: '4' }, { ATTL: 116, ATVL: 'No 1 Côte' }]], ['FSPT', [ptr(110, 1, { ORNT: 255, USAG: 255 })]]]);
  recs.push([frid(3, 1, 129), foid(3), ['FSPT', [ptr(110, 2)]]]);
  return file(recs);
}

test('reads a base cell: areas, masked outline, points, soundings', () => {
  const cell = readCell(baseCell());
  assert.deepEqual(cell.info(), {
    name: 'XX5TEST', band: 5, edition: 3, update: 0, issued: '20260101', agency: 550, scale: 22000, comment: '', cancelled: false,
  });
  const g = cell.toGeoJSON();
  const dep = g.features.find((f) => f.properties.c === 'DEPARE' && !f.properties.ol);
  assert.equal(dep.properties.a.DRVAL1, '5');
  assert.equal(dep.properties.ns, 1);
  assert.equal(dep.geometry.coordinates.length, 1);
  assert.equal(dep.geometry.coordinates[0].length, 6); // 4 corners + extra vertex + closing point
  assert.deepEqual(dep.geometry.coordinates[0][1], [10.05, 50.000003]);
  const outline = g.features.find((f) => f.properties.c === 'DEPARE' && f.properties.ol);
  assert.equal(outline.geometry.coordinates.flat().length, 5); // edge 3 is masked
  const buoy = g.features.find((f) => f.properties.c === 'BOYLAT');
  assert.deepEqual(buoy.geometry.coordinates, [10.05, 50.05]);
  assert.equal(buoy.properties.a.OBJNAM, 'No 1 Côte');
  const s = g.features.find((f) => f.properties.c === 'SOUNDG');
  assert.deepEqual(s.geometry.coordinates, [[10.02, 50.02, 12.3], [10.03, 50.03, 4.5]]);
});

test('applies updates in order: attributes, deletion, insertion, coordinates', () => {
  const upd1 = file([
    [dsid(1)],
    // Move the buoy's node and change its colour, delete the depth area's DRVAL2.
    [vrid(110, 1, 3), ['SGCC', { CCUI: 3, CCIX: 1, CCNC: 1 }], ['SG2D', [xy(10.06, 50.06)]]],
    [frid(2, 1, 17, 3), ['ATTF', [{ ATTL: 75, ATVL: '3' }]]],
    [frid(1, 3, 42, 3), ['ATTF', [{ ATTL: 88, ATVL: '\x7f' }]]],
  ]);
  const upd2 = file([
    [dsid(2)],
    [frid(3, 1, 129, 2)],
    [vrid(110, 3), ['SG2D', [xy(10.07, 50.07)]]],
    [frid(4, 1, 75), foid(4), ['ATTF', [{ ATTL: 75, ATVL: '1,3' }]], ['FSPT', [ptr(110, 3)]]],
  ]);
  const upd4 = file([[dsid(4)], [frid(1, 3, 42, 2)]]); // gap: .003 missing, must not apply
  const cell = readCell(baseCell(), [upd4, upd2, upd1]);
  assert.equal(cell.info().update, 2);
  const g = cell.toGeoJSON();
  const by = (c) => g.features.filter((f) => f.properties.c === c && !f.properties.ol);
  assert.deepEqual(by('BOYLAT')[0].geometry.coordinates, [10.06, 50.06]);
  assert.equal(by('BOYLAT')[0].properties.a.COLOUR, '3');
  assert.deepEqual(by('DEPARE')[0].properties.a, { DRVAL1: '5' });
  assert.equal(by('SOUNDG').length, 0);
  assert.deepEqual(by('LIGHTS')[0].geometry.coordinates, [10.07, 50.07]);
});

test('rejects files that are not S-57 (e.g. encrypted S-63)', () => {
  assert.throws(() => readCell(Buffer.from('\x8a\x01garbage that is not iso 8211 at all.....')), /Not an S-57/);
});

const gdalSample = '/home/user/osgeo/gdal/autotest/ogr/data/s57/bug2147_3R7D0889.000';
test('matches GDAL on a real cell', { skip: !fs.existsSync(gdalSample) }, () => {
  const g = readCell(fs.readFileSync(path.resolve(gdalSample))).toGeoJSON();
  const area = (r) => Math.abs(r.slice(1).reduce((s, p, i) => s + r[i][0] * p[1] - p[0] * r[i][1], 0) / 2);
  const dep = g.features.find((f) => f.properties.c === 'DEPARE' && f.properties.id === 167 && !f.properties.ol);
  assert.equal(dep.geometry.coordinates[0].length, 860);
  assert.ok(Math.abs(area(dep.geometry.coordinates[0]) - 0.0004210872847949699) < 1e-12);
});
