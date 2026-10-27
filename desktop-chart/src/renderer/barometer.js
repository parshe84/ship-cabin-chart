'use strict';

// Barometer: pressure history from the phone (or a ship's weather station), the 1 h / 3 h trend,
// a sparkline for the HUD, a full chart, and the storm warning (3 hPa fall in 3 hours).

(function () {
  const KEEP_MS = 72 * 3600e3;
  const SAMPLE_MS = 5 * 60e3; // one stored sample per 5 minutes

  class Barometer {
    constructor({ load, save, onAlert }) {
      this.samples = []; // [timeMs, hPa]
      this.pending = [];
      this.save = save;
      this.onAlert = onAlert;
      this.lastAlert = 0;
      this.ready = load().then((data) => {
        if (Array.isArray(data)) this.samples = data.filter((s) => Date.now() - s[0] < KEEP_MS);
      });
    }

    add(hPa, t = Date.now()) {
      this.pending.push(hPa);
      const last = this.samples[this.samples.length - 1];
      if (last && t - last[0] < SAMPLE_MS) return;
      // Store the mean of the readings since the last sample.
      const mean = this.pending.reduce((a, b) => a + b, 0) / this.pending.length;
      this.pending = [];
      this.samples.push([t, Math.round(mean * 10) / 10]);
      while (this.samples.length && t - this.samples[0][0] > KEEP_MS) this.samples.shift();
      this.save(this.samples);
      this.check(t);
    }

    // Chart window that fits the history: at least `min` hours, at most `max`.
    span(min, max) {
      if (this.samples.length < 2) return min;
      const h = (Date.now() - this.samples[0][0]) / 3600e3;
      return Math.max(min, Math.min(max, Math.ceil(h * 1.15)));
    }

    trend(now = Date.now()) {
      return NavCore.pressureTrend(this.samples, now);
    }

    check(now) {
      const tr = this.trend(now);
      if (tr && tr.alert && now - this.lastAlert > 30 * 60e3) {
        this.lastAlert = now;
        this.onAlert(tr);
      }
    }

    // SVG line chart of the last `hours`. Width/height in px.
    svg(hours, width, height, { axes = false } = {}) {
      const now = Date.now();
      const pts = this.samples.filter((s) => now - s[0] <= hours * 3600e3);
      if (pts.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
      let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
      if (hi - lo < 4) {
        const mid = (hi + lo) / 2;
        lo = mid - 2;
        hi = mid + 2;
      }
      const pad = axes ? 34 : 2;
      const x = (t) => pad + ((t - (now - hours * 3600e3)) / (hours * 3600e3)) * (width - pad - 4);
      const y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (height - (axes ? 26 : 10));
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
      const area = `${d}L${x(pts[pts.length - 1][0]).toFixed(1)},${height - (axes ? 20 : 2)}L${x(pts[0][0]).toFixed(1)},${height - (axes ? 20 : 2)}Z`;
      let grid = '';
      if (axes) {
        const step = hi - lo > 20 ? 5 : hi - lo > 8 ? 2 : 1;
        for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
          grid += `<line class="gl" x1="${pad}" x2="${width - 4}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pad - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
        }
        for (let h = 0; h <= hours; h += hours > 24 ? 12 : hours > 8 ? 3 : 1) {
          const tx = x(now - h * 3600e3);
          grid += `<text class="ax" x="${tx}" y="${height - 4}" text-anchor="middle">${h ? `−${h}h` : 'now'}</text>`;
        }
      }
      return `<svg class="baro-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <defs><linearGradient id="baro-fill-${width}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--accent)" stop-opacity="0.35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient></defs>
        ${grid}<path d="${area}" fill="url(#baro-fill-${width})"/><path class="line" d="${d}"/>
      </svg>`;
    }
  }

  // Short attention tone (no audio files needed).
  function alarmTone() {
    try {
      const ctx = new AudioContext();
      [0, 0.35, 0.7].forEach((t) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.3);
      });
    } catch { /* audio unavailable */ }
  }

  window.Barometer = Barometer;
  window.alarmTone = alarmTone;
})();
