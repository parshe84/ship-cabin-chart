'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { AisDecoder, SIXBIT_TEXT } = require('../src/ais');

// A tiny AIS encoder, independent of the decoder, to build test sentences field by field.
function encode(fields) {
  let bits = '';
  for (const [value, len, kind] of fields) {
    if (kind === 'text') {
      const s = value.padEnd(len / 6, '@').slice(0, len / 6);
      for (const ch of s) bits += SIXBIT_TEXT.indexOf(ch).toString(2).padStart(6, '0');
    } else {
      const v = value < 0 ? 2 ** len + value : value;
      bits += Math.round(v).toString(2).padStart(len, '0');
    }
  }
  const fill = (6 - (bits.length % 6)) % 6;
  bits += '0'.repeat(fill);
  let payload = '';
  for (let i = 0; i < bits.length; i += 6) {
    let v = parseInt(bits.slice(i, i + 6), 2);
    v += v > 39 ? 56 : 48;
    payload += String.fromCharCode(v);
  }
  return { payload, fill };
}

function sentence(body) {
  let sum = 0;
  for (const c of body) sum ^= c.charCodeAt(0);
  return `!${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}

test('type 1 position report', () => {
  const { payload, fill } = encode([
    [1, 6], [0, 2], [244123456, 30], [0, 4], [0, 8], [125, 10], [1, 1],
    [Math.round(4.05 * 600000), 28], [Math.round(51.95 * 600000), 27],
    [2453, 12], [244, 9], [30, 6], [0, 2], [0, 3], [0, 1], [0, 19],
  ]);
  const msg = new AisDecoder().push(sentence(`AIVDM,1,1,,A,${payload},${fill}`));
  assert.strictEqual(msg.type, 1);
  assert.strictEqual(msg.mmsi, 244123456);
  assert.strictEqual(msg.sog, 12.5);
  assert.strictEqual(msg.cog, 245.3);
  assert.strictEqual(msg.heading, 244);
  assert.ok(Math.abs(msg.lat - 51.95) < 1e-6 && Math.abs(msg.lon - 4.05) < 1e-6);
});

test('negative coordinates and "not available" values', () => {
  const { payload, fill } = encode([
    [1, 6], [0, 2], [123456789, 30], [5, 4], [0, 8], [1023, 10], [0, 1],
    [Math.round(-70.5 * 600000), 28], [Math.round(-33.1 * 600000), 27],
    [3600, 12], [511, 9], [60, 6], [0, 2], [0, 3], [0, 1], [0, 19],
  ]);
  const msg = new AisDecoder().push(sentence(`AIVDM,1,1,,B,${payload},${fill}`));
  assert.ok(Math.abs(msg.lon + 70.5) < 1e-6 && Math.abs(msg.lat + 33.1) < 1e-6);
  assert.strictEqual(msg.sog, null);
  assert.strictEqual(msg.cog, null);
  assert.strictEqual(msg.heading, null);
  assert.strictEqual(msg.navStatus, 5);
});

test('type 5 static data split over two sentences', () => {
  const { payload, fill } = encode([
    [5, 6], [0, 2], [244123456, 30], [0, 2], [9123456, 30], ['PDAB', 42, 'text'], ['NORTHERN STAR', 120, 'text'],
    [70, 8], [150, 9], [40, 9], [16, 6], [16, 6], [1, 4], [10, 4], [27, 5], [12, 5], [0, 6], [105, 8],
    ['SINGAPORE', 120, 'text'], [0, 1], [0, 1],
  ]);
  const half = Math.floor(payload.length / 2);
  const dec = new AisDecoder();
  assert.strictEqual(dec.push(sentence(`AIVDM,2,1,7,A,${payload.slice(0, half)},0`)), null);
  const msg = dec.push(sentence(`AIVDM,2,2,7,A,${payload.slice(half)},${fill}`));
  assert.strictEqual(msg.type, 5);
  assert.strictEqual(msg.name, 'NORTHERN STAR');
  assert.strictEqual(msg.callsign, 'PDAB');
  assert.strictEqual(msg.destination, 'SINGAPORE');
  assert.strictEqual(msg.shipType, 70);
  assert.strictEqual(msg.length, 190);
  assert.strictEqual(msg.draught, 10.5);
});

test('class B type 18 and 24A', () => {
  const p18 = encode([
    [18, 6], [0, 2], [366999999, 30], [0, 8], [62, 10], [0, 1],
    [Math.round(-122.4 * 600000), 28], [Math.round(37.8 * 600000), 27], [900, 12], [511, 9], [0, 6], [0, 2],
    [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 20],
  ]);
  const dec = new AisDecoder();
  const b = dec.push(sentence(`AIVDM,1,1,,B,${p18.payload},${p18.fill}`));
  assert.strictEqual(b.class, 'B');
  assert.strictEqual(b.sog, 6.2);
  assert.strictEqual(b.cog, 90);
  const p24 = encode([[24, 6], [0, 2], [366999999, 30], [0, 2], ['SEA BREEZE', 120, 'text'], [0, 8]]);
  assert.strictEqual(dec.push(sentence(`AIVDM,1,1,,B,${p24.payload},${p24.fill}`)).name, 'SEA BREEZE');
});

test('bad checksum and other sentences are ignored', () => {
  const dec = new AisDecoder();
  assert.strictEqual(dec.push('!AIVDM,1,1,,A,13u?etPv2;0n:dDPwUM1U1Cb069D,0*00'), null);
  assert.strictEqual(dec.push('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A'), null);
});
