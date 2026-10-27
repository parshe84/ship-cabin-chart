const test = require('node:test');
const assert = require('node:assert');
const { parseRtz, parseRouteFile, buildRtz } = require('../src/rtz');

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported by ECDIS -->
<rtz:route xmlns:rtz="http://www.cirm.org/RTZ/1/1" version="1.1">
  <rtz:routeInfo routeName="RICHARDS BAY - SINGAPORE" vesselName="TEST"/>
  <rtz:waypoints>
    <rtz:defaultWaypoint radius="0.5"><rtz:leg starboardXTD="0.1" portXTD="0.1"/></rtz:defaultWaypoint>
    <rtz:waypoint id="1" name="RB PILOT" radius="0.3">
      <rtz:position lat="-28.8167" lon="32.1000"/>
    </rtz:waypoint>
    <rtz:waypoint id='2' name='OFF &amp; AWAY'>
      <rtz:position lon='60.5' lat='-20.25'/>
      <rtz:leg geometryType="Loxodrome" speedMax="14"/>
    </rtz:waypoint>
    <rtz:waypoint id="3" name="SINGAPORE">
      <rtz:position lat="1.2000" lon="103.8500"/>
    </rtz:waypoint>
  </rtz:waypoints>
</rtz:route>`;

test('parses an RTZ 1.1 route with namespace prefixes', () => {
  const r = parseRtz(sample);
  assert.equal(r.name, 'RICHARDS BAY - SINGAPORE');
  assert.equal(r.waypoints.length, 3);
  assert.deepEqual(r.waypoints[1], { lat: -20.25, lon: 60.5, name: 'OFF & AWAY' });
  assert.equal(r.waypoints[2].lon, 103.85);
});

test('reads UTF-16 RTZ files', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sample.replace('UTF-8', 'UTF-16'), 'utf16le')]);
  assert.equal(parseRouteFile(buf, 'a.rtz').waypoints.length, 3);
});

test('rejects files without a route and bad positions', () => {
  assert.throws(() => parseRtz('<route><waypoints></waypoints></route>'), /at least two/);
  assert.throws(() => parseRtz('<route><waypoint id="1"><position lat="95" lon="0"/></waypoint></route>'), /invalid position/);
});

test('export round-trips through the parser and wraps longitude', () => {
  const xml = buildRtz([{ lat: 10, lon: 170 }, { lat: 11, lon: 185, auto: true }, { lat: 12, lon: 190 }], 'A < B');
  assert.match(xml, /xmlns="http:\/\/www.cirm.org\/RTZ\/1\/0"/);
  const r = parseRtz(xml);
  assert.equal(r.name, 'A < B');
  assert.deepEqual(r.waypoints.map((w) => w.lon), [170, -175, -170]);
  assert.deepEqual(r.waypoints.map((w) => w.name), ['Start', 'Lane 1', 'Destination']);
});

test('imports a GPX route', () => {
  const gpx = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><rte><name>Plan</name>
    <rtept lat="1" lon="2"><name>A</name></rtept><rtept lat="3" lon="4"><name>B</name></rtept></rte></gpx>`;
  const r = parseRouteFile(gpx, 'x.gpx');
  assert.equal(r.name, 'Plan');
  assert.deepEqual(r.waypoints[1], { lat: 3, lon: 4, name: 'B' });
});
