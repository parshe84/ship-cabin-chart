'use strict';

// AIS decoder for !AIVDM sentences (ITU-R M.1371): position reports of class A (types 1-3) and
// class B (18, 19), static and voyage data (5) and class B static data (24). Multi-part messages
// are assembled by sequence id and channel.

const SIXBIT_TEXT = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?';

function checksumOk(sentence) {
  const star = sentence.lastIndexOf('*');
  if (star === -1) return true;
  let sum = 0;
  for (let i = 1; i < star; i++) sum ^= sentence.charCodeAt(i);
  return sum === parseInt(sentence.slice(star + 1, star + 3), 16);
}

// Payload characters -> array of bits.
function toBits(payload, fillBits) {
  const bits = [];
  for (const ch of payload) {
    let v = ch.charCodeAt(0) - 48;
    if (v > 40) v -= 8;
    for (let b = 5; b >= 0; b--) bits.push((v >> b) & 1);
  }
  return fillBits ? bits.slice(0, bits.length - fillBits) : bits;
}

function uint(bits, start, len) {
  let v = 0;
  for (let i = start; i < start + len; i++) v = v * 2 + (bits[i] || 0);
  return v;
}

function int(bits, start, len) {
  const v = uint(bits, start, len);
  return bits[start] ? v - 2 ** len : v;
}

function text(bits, start, len) {
  let s = '';
  for (let i = start; i + 6 <= start + len && i + 6 <= bits.length; i += 6) s += SIXBIT_TEXT[uint(bits, i, 6)];
  return s.replace(/@.*$/, '').trim();
}

function position(bits, lonStart) {
  const lon = int(bits, lonStart, 28) / 600000;
  const lat = int(bits, lonStart + 28, 27) / 600000;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return {};
  return { lat, lon };
}

const sog = (raw) => (raw === 1023 ? null : raw / 10);
const cog = (raw) => (raw >= 3600 ? null : raw / 10);
const hdg = (raw) => (raw >= 360 ? null : raw);

function decodePayload(bits) {
  const type = uint(bits, 0, 6);
  const mmsi = uint(bits, 8, 30);
  const base = { type, mmsi };
  switch (type) {
    case 1: case 2: case 3:
      return {
        ...base,
        class: 'A',
        navStatus: uint(bits, 38, 4),
        sog: sog(uint(bits, 50, 10)),
        ...position(bits, 61),
        cog: cog(uint(bits, 116, 12)),
        heading: hdg(uint(bits, 128, 9)),
      };
    case 5:
      return {
        ...base,
        class: 'A',
        imo: uint(bits, 40, 30) || null,
        callsign: text(bits, 70, 42),
        name: text(bits, 112, 120),
        shipType: uint(bits, 232, 8),
        length: uint(bits, 240, 9) + uint(bits, 249, 9) || null,
        beam: uint(bits, 258, 6) + uint(bits, 264, 6) || null,
        draught: uint(bits, 294, 8) / 10 || null,
        destination: text(bits, 302, 120),
      };
    case 18:
      return {
        ...base,
        class: 'B',
        sog: sog(uint(bits, 46, 10)),
        ...position(bits, 57),
        cog: cog(uint(bits, 112, 12)),
        heading: hdg(uint(bits, 124, 9)),
      };
    case 19:
      return {
        ...base,
        class: 'B',
        sog: sog(uint(bits, 46, 10)),
        ...position(bits, 57),
        cog: cog(uint(bits, 112, 12)),
        heading: hdg(uint(bits, 124, 9)),
        name: text(bits, 143, 120),
        shipType: uint(bits, 263, 8),
        length: uint(bits, 271, 9) + uint(bits, 280, 9) || null,
      };
    case 24: {
      const part = uint(bits, 38, 2);
      if (part === 0) return { ...base, class: 'B', name: text(bits, 40, 120) };
      return {
        ...base,
        class: 'B',
        shipType: uint(bits, 40, 8),
        callsign: text(bits, 90, 42),
        length: uint(bits, 132, 9) + uint(bits, 141, 9) || null,
      };
    }
    default:
      return null; // other message types (base stations, safety messages…) are ignored
  }
}

class AisDecoder {
  constructor() {
    this.pending = new Map(); // "seq:channel" -> { parts: [], count, t }
  }

  // Returns a decoded message object, or null (incomplete, unsupported or invalid).
  push(line, now = Date.now()) {
    const s = line.trim();
    if (!/^!AIVD[MO],/.test(s) || !checksumOk(s)) return null;
    const own = s.startsWith('!AIVDO');
    const f = s.split('*')[0].split(',');
    const count = parseInt(f[1], 10);
    const num = parseInt(f[2], 10);
    const seq = f[3];
    const channel = f[4];
    const payload = f[5] || '';
    const fill = parseInt(f[6], 10) || 0;
    if (!count || !num || !/^[0-W`-w]*$/.test(payload)) return null;

    let full = payload;
    let fillBits = fill;
    if (count > 1) {
      for (const [k, v] of this.pending) if (now - v.t > 10000) this.pending.delete(k);
      const key = `${seq}:${channel}`;
      const entry = this.pending.get(key) || { parts: [], count, t: now };
      entry.parts[num - 1] = payload;
      this.pending.set(key, entry);
      if (num !== count || entry.parts.filter((p) => p != null).length !== count) return null;
      this.pending.delete(key);
      full = entry.parts.join('');
      fillBits = fill;
    }
    const msg = decodePayload(toBits(full, fillBits));
    if (!msg || !msg.mmsi) return null;
    if (own) msg.own = true;
    return msg;
  }
}

module.exports = { AisDecoder, toBits, decodePayload, SIXBIT_TEXT };
