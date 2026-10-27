'use strict';

// Solar elevation (degrees) for a position and time, NOAA approximation (±0.5°).
// Used by the Auto theme: night when the sun is below civil twilight at the ship.
(function () {
  const rad = Math.PI / 180;

  function sunElevation(lat, lon, date = new Date()) {
    const jd = date.getTime() / 86400000 + 2440587.5;
    const t = (jd - 2451545) / 36525;
    const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const c = Math.sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t))
      + Math.sin(2 * m * rad) * (0.019993 - 0.000101 * t)
      + Math.sin(3 * m * rad) * 0.000289;
    const trueLong = l0 + c;
    const omega = 125.04 - 1934.136 * t;
    const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
    const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * rad);
    const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));

    const y = Math.tan((eps / 2) * rad) ** 2;
    const eqTime = 4 / rad * (y * Math.sin(2 * l0 * rad) - 2 * e * Math.sin(m * rad)
      + 4 * e * y * Math.sin(m * rad) * Math.cos(2 * l0 * rad)
      - 0.5 * y * y * Math.sin(4 * l0 * rad) - 1.25 * e * e * Math.sin(2 * m * rad));

    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    const trueSolarTime = (minutes + eqTime + 4 * lon + 1440) % 1440;
    const hourAngle = trueSolarTime / 4 - 180;
    const cosZenith = Math.sin(lat * rad) * Math.sin(decl)
      + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(hourAngle * rad);
    return 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) / rad;
  }

  // Times (ms) when the sun crosses `altitude` degrees during the 24 h around local noon at the
  // position. Returns { rise, set } (either may be null) and polar day/night flags.
  function crossings(lat, lon, date, altitude) {
    // Local solar noon is roughly 12:00 UTC shifted by longitude.
    const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    let noon = day + (12 - lon / 15) * 3600e3;
    if (date.getTime() - noon > 12 * 3600e3) noon += 86400e3;
    if (noon - date.getTime() > 12 * 3600e3) noon -= 86400e3;
    const f = (t) => sunElevation(lat, lon, new Date(t)) - altitude;
    const step = 10 * 60e3;
    let rise = null, set = null;
    let prevT = noon - 12 * 3600e3, prev = f(prevT);
    let anyAbove = prev > 0, anyBelow = prev <= 0;
    for (let t = prevT + step; t <= noon + 12 * 3600e3; t += step) {
      const v = f(t);
      if (v > 0) anyAbove = true; else anyBelow = true;
      if ((prev <= 0) !== (v <= 0)) {
        let a = prevT, b = t;
        for (let i = 0; i < 20; i++) {
          const m = (a + b) / 2;
          if ((f(a) <= 0) === (f(m) <= 0)) a = m; else b = m;
        }
        if (prev <= 0) rise = rise ?? b; else set = set ?? b;
      }
      prevT = t;
      prev = v;
    }
    return { rise, set, polarDay: anyAbove && !anyBelow, polarNight: anyBelow && !anyAbove };
  }

  // Sunrise/sunset (upper limb with refraction, -0.833°) and civil twilight (-6°).
  function sunTimes(lat, lon, date = new Date()) {
    const sun = crossings(lat, lon, date, -0.833);
    const civil = crossings(lat, lon, date, -6);
    return { sunrise: sun.rise, sunset: sun.set, dawn: civil.rise, dusk: civil.set, polarDay: sun.polarDay, polarNight: sun.polarNight };
  }

  // Moon phase from the mean synodic month (good to a few hours, plenty for a phase picture).
  function moonPhase(date = new Date()) {
    const synodic = 29.530588853;
    const knownNew = Date.UTC(2000, 0, 6, 18, 14);
    const age = (((date.getTime() - knownNew) / 86400e3) % synodic + synodic) % synodic;
    const phase = age / synodic; // 0 new, 0.5 full
    const illumination = (1 - Math.cos(2 * Math.PI * phase)) / 2;
    const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon',
      'Waning gibbous', 'Last quarter', 'Waning crescent'];
    return { age, phase, illumination, name: names[Math.round(phase * 8) % 8], waxing: phase < 0.5 };
  }

  // Nautical time zone from longitude: zone description ZD = -round(lon / 15), local = UTC - ZD.
  function zoneTime(lon, date = new Date()) {
    const offset = Math.round(lon / 15);
    const zd = -offset;
    const local = new Date(date.getTime() + offset * 3600e3);
    return { offset, zd, label: zd === 0 ? 'ZD 0' : `ZD ${zd > 0 ? '+' : '−'}${Math.abs(zd)}`, local };
  }

  window.Sun = { sunElevation, sunTimes, moonPhase, zoneTime };
})();
