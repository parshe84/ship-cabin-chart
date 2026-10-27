'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const nav = require('../src/renderer/nav-core');

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('rhumb line: one degree of latitude is 60 nm due north', () => {
  const r = nav.rhumb([10, 20], [11, 20]);
  near(r.distanceNm, 60, 0.2);
  near(r.bearing, 0, 1e-6);
});

test('rhumb line: along the equator heads 090 and 60 nm per degree', () => {
  const r = nav.rhumb([0, 0], [0, 1]);
  near(r.distanceNm, 60.04, 0.1);
  near(r.bearing, 90, 1e-6);
});

test('rhumb line crosses the antimeridian the short way', () => {
  const r = nav.rhumb([0, 179.5], [0, -179.5]);
  near(r.distanceNm, 60.04, 0.1);
  near(r.bearing, 90, 1e-6);
});

test('unwrapPath keeps longitudes continuous', () => {
  assert.deepStrictEqual(nav.unwrapPath([[0, 179], [0, -179]]), [[0, 179], [0, 181]]);
});

test('routeProgress: XTE sign, distance to go and waypoint advance', () => {
  const wps = [[0, 0], [0, 1], [1, 1]];
  // 3 nm south of the first leg (heading east): ship is to starboard, XTE > 0
  const p = nav.routeProgress(wps, [-0.05, 0.5], 1);
  assert.strictEqual(p.active, 1);
  near(p.xteNm, 3, 0.05);
  near(p.dtgNm, nav.rhumb([-0.05, 0.5], [0, 1]).distanceNm + 60, 0.5);
  // Past the first waypoint: the second leg becomes active
  const q = nav.routeProgress(wps, [0.1, 1.01], 1);
  assert.strictEqual(q.active, 2);
  near(q.toNextNm, 54, 0.6);
});

test('SpeedAverage averages over the window', () => {
  const s = new nav.SpeedAverage(60000);
  s.add(10, 0);
  s.add(12, 30000);
  s.add(14, 120000); // the first two samples fall out of the window
  assert.strictEqual(s.value, 14);
});

test('formatDuration', () => {
  assert.strictEqual(nav.formatDuration(1.5), '1h 30m');
  assert.strictEqual(nav.formatDuration(50), '2d 02h');
});

test('sea router: Rotterdam to Singapore goes via Suez, ~8,300 nm', () => {
  const network = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/maps/world/sea-routes.json'), 'utf8'));
  const router = new nav.SeaRouter(network);
  const r = router.route([51.95, 4.05], [1.26, 103.84]);
  assert.ok(r, 'route found');
  assert.ok(r.passages.includes('suez'), `passages: ${r.passages}`);
  near(r.distanceNm, 8300, 250);
  const cape = router.route([51.95, 4.05], [1.26, 103.84], ['suez', 'northwest']);
  assert.ok(cape.passages.includes('south_africa'), `passages: ${cape.passages}`);
  assert.ok(cape.distanceNm > r.distanceNm + 2500, 'avoiding Suez goes round the Cape');
});

test('pressureTrend: storm warning on a 3 hPa fall in 3 hours', () => {
  const now = 10 * 3600e3;
  const steady = [[now - 3 * 3600e3, 1012], [now - 3600e3, 1012], [now, 1011.5]];
  assert.strictEqual(nav.pressureTrend(steady, now).alert, null);
  const falling = [[now - 3 * 3600e3, 1010], [now - 2 * 3600e3, 1009], [now - 3600e3, 1008.5], [now, 1006.6]];
  const t = nav.pressureTrend(falling, now);
  near(t.change3h, -3.4, 1e-9);
  assert.strictEqual(t.alert, 'storm');
  assert.strictEqual(nav.pressureTrend([[now - 3 * 3600e3, 1010], [now, 1003]], now).alert, 'severe');
  // Not enough history: no 3 h change, no false alarm
  assert.strictEqual(nav.pressureTrend([[now, 1000]], now).change3h, null);
});

test('HeadingCalibration learns the phone mounting offset only when steady', () => {
  const c = new nav.HeadingCalibration();
  for (let i = 0; i < 40; i++) c.add(250 + (i % 3), 160 + (i % 3), 12); // phone sideways, 90° off
  near(c.offset, 90, 1);
  near(c.heading(170), 260, 1);
  const slow = new nav.HeadingCalibration();
  for (let i = 0; i < 40; i++) slow.add(250, 160, 1); // at anchor: COG is meaningless
  assert.strictEqual(slow.offset, null);
});

test('CPA/TCPA: crossing target and opening target', () => {
  // Own ship north at 10 kn, target 10 nm east heading west at 10 kn: the relative motion runs
  // diagonally, so the closest approach is 10/sqrt(2) = 7.07 nm after 30 minutes.
  const own = { lat: 0, lon: 0, sog: 10, cog: 0 };
  const tgt = { lat: 0, lon: 10 / 60, sog: 10, cog: 270 };
  const r = nav.cpa(own, tgt);
  near(r.rangeNm, 10, 0.05);
  near(r.tcpaMin, 30, 0.5);
  near(r.cpaNm, 7.07, 0.05);
  // Head-on collision course: CPA 0
  const head = nav.cpa(own, { lat: 10 / 60, lon: 0, sog: 10, cog: 180 });
  near(head.cpaNm, 0, 0.01);
  near(head.tcpaMin, 30, 0.5);
  // Target astern and slower: opening, TCPA negative
  assert.ok(nav.cpa(own, { lat: -0.05, lon: 0, sog: 5, cog: 0 }).tcpaMin < 0);
});
