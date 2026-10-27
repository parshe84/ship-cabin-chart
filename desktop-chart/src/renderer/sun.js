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

  window.Sun = { sunElevation };
})();
