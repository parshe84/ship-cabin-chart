'use strict';

// Minimal NMEA 0183 parser: RMC, GGA, VTG (any talker: GP, GN, GL, GA...).

function checksumOk(sentence) {
  const star = sentence.lastIndexOf('*');
  if (star === -1) return true; // checksum is optional in NMEA
  const expected = parseInt(sentence.slice(star + 1, star + 3), 16);
  let sum = 0;
  for (let i = 1; i < star; i++) sum ^= sentence.charCodeAt(i);
  return sum === expected;
}

// "5545.1234", "N" -> 55.752056
function parseCoord(value, hemi) {
  if (!value) return null;
  const dot = value.indexOf('.');
  const degLen = (dot === -1 ? value.length : dot) - 2;
  const deg = parseInt(value.slice(0, degLen), 10);
  const min = parseFloat(value.slice(degLen));
  if (Number.isNaN(deg) || Number.isNaN(min)) return null;
  const result = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -result : result;
}

function num(value) {
  if (value === undefined || value === '') return null;
  const n = parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

function parseTime(hhmmss, ddmmyy) {
  if (!hhmmss || hhmmss.length < 6) return null;
  const h = +hhmmss.slice(0, 2), m = +hhmmss.slice(2, 4), s = parseFloat(hhmmss.slice(4));
  const now = new Date();
  let y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate();
  if (ddmmyy && ddmmyy.length === 6) {
    d = +ddmmyy.slice(0, 2);
    mo = +ddmmyy.slice(2, 4) - 1;
    const yy = +ddmmyy.slice(4, 6);
    y = yy < 80 ? 2000 + yy : 1900 + yy;
  }
  return Date.UTC(y, mo, d, h, m, Math.floor(s), Math.round((s % 1) * 1000));
}

// Returns a partial fix object, or null if the sentence is unsupported/invalid.
function parseSentence(raw) {
  const sentence = raw.trim();
  if (!sentence.startsWith('$') || !checksumOk(sentence)) return null;
  const body = sentence.split('*')[0];
  const f = body.split(',');
  const type = f[0].slice(3);

  switch (type) {
    case 'RMC': {
      if (f[2] !== 'A') return { type, valid: false };
      return {
        type,
        valid: true,
        time: parseTime(f[1], f[9]),
        lat: parseCoord(f[3], f[4]),
        lon: parseCoord(f[5], f[6]),
        sog: num(f[7]), // knots
        cog: num(f[8]), // degrees true
      };
    }
    case 'GGA': {
      const quality = parseInt(f[6], 10) || 0;
      if (quality === 0) return { type, valid: false };
      return {
        type,
        valid: true,
        lat: parseCoord(f[2], f[3]),
        lon: parseCoord(f[4], f[5]),
        satellites: parseInt(f[7], 10) || null,
        hdop: num(f[8]),
        altitude: num(f[9]),
      };
    }
    case 'VTG':
      return { type, valid: true, cog: num(f[1]), sog: num(f[5]) };
    case 'HDT': {
      const heading = num(f[1]);
      return heading == null ? null : { type, valid: true, heading };
    }
    case 'HDG': {
      // Magnetic heading + variation (E positive) = true heading.
      const mag = num(f[1]);
      if (mag == null) return null;
      const variation = (num(f[4]) || 0) * (f[5] === 'W' ? -1 : 1);
      return { type, valid: true, heading: (((mag + variation) % 360) + 360) % 360 };
    }
    case 'XDR': {
      // Transducer quadruplets: type, value, unit, name. Pressure in bar (B) or pascal (P).
      for (let i = 1; i + 2 < f.length; i += 4) {
        if (f[i] !== 'P') continue;
        const v = num(f[i + 1]);
        if (v == null) continue;
        const hPa = f[i + 2] === 'B' ? v * 1000 : f[i + 2] === 'P' ? v / 100 : null;
        if (hPa && hPa > 850 && hPa < 1100) return { type, valid: true, pressure: hPa };
      }
      return null;
    }
    case 'GSV': {
      // Satellites in view, one sentence group per talker (GP, GL, GA, GB/BD, GQ, GI).
      const inView = parseInt(f[3], 10);
      if (Number.isNaN(inView)) return null;
      const talker = f[0].slice(1, 3) === 'BD' ? 'GB' : f[0].slice(1, 3);
      return { type, valid: true, talker, inView, part: parseInt(f[2], 10) || 1 };
    }
    case 'MDA': {
      // Meteorological composite: pressure in inches (f[1]) and bar (f[3]).
      const bar = num(f[3]);
      const inch = num(f[1]);
      const hPa = bar != null ? bar * 1000 : inch != null ? inch * 33.8639 : null;
      return hPa ? { type, valid: true, pressure: hPa } : null;
    }
    default:
      return null;
  }
}

module.exports = { parseSentence, parseCoord, checksumOk };
