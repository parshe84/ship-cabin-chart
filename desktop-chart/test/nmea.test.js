'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseSentence, parseCoord, checksumOk } = require('../src/nmea');

function withChecksum(body) {
  let sum = 0;
  for (const c of body) sum ^= c.charCodeAt(0);
  return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}

test('parseCoord converts ddmm.mmmm to decimal degrees', () => {
  assert.ok(Math.abs(parseCoord('4807.038', 'N') - 48.1173) < 1e-4);
  assert.ok(Math.abs(parseCoord('01131.000', 'E') - 11.516667) < 1e-5);
  assert.ok(parseCoord('01131.000', 'W') < 0);
  assert.ok(parseCoord('3352.500', 'S') < 0);
});

test('checksum validation', () => {
  assert.ok(checksumOk('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A'));
  assert.ok(!checksumOk('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6B'));
});

test('RMC sentence', () => {
  const fix = parseSentence('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A');
  assert.strictEqual(fix.valid, true);
  assert.strictEqual(fix.sog, 22.4);
  assert.strictEqual(fix.cog, 84.4);
  assert.strictEqual(new Date(fix.time).toISOString(), '1994-03-23T12:35:19.000Z');
});

test('RMC with modern date and GN talker', () => {
  const fix = parseSentence(withChecksum('GNRMC,083015.00,A,5958.1200,N,03012.6000,E,5.5,270.0,271026,,,A'));
  assert.strictEqual(new Date(fix.time).toISOString(), '2026-10-27T08:30:15.000Z');
  assert.ok(Math.abs(fix.lat - 59.968667) < 1e-5);
});

test('GGA sentence', () => {
  const fix = parseSentence('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47');
  assert.strictEqual(fix.valid, true);
  assert.strictEqual(fix.satellites, 8);
  assert.strictEqual(fix.altitude, 545.4);
});

test('void RMC is reported as invalid', () => {
  const fix = parseSentence(withChecksum('GPRMC,123519,V,,,,,,,230394,,'));
  assert.strictEqual(fix.valid, false);
});

test('unsupported sentences return null', () => {
  assert.strictEqual(parseSentence(withChecksum('GPGSV,1,1,00')), null);
  assert.strictEqual(parseSentence('garbage'), null);
});
