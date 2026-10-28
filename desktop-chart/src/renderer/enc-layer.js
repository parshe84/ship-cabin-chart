'use strict';

// Official S-57 ENC charts drawn on canvas tiles with a simplified IHO S-52 presentation:
// depth areas shaded by the mariner's safety contour, soundings, dangers, buoys and beacons,
// lights with sectors and characteristics, traffic schemes, restricted areas and names.
// Cells are loaded lazily from the library (main process) and sliced with geojson-vt.

(function () {
  const EXTENT = 4096;
  const INDEX_MAX_ZOOM = 17;
  const MAX_LOADED = 80;
  // A cell is drawn from this zoom up, by navigational purpose (1 overview … 6 berthing).
  const BAND_MIN_ZOOM = { 0: 9, 1: 3, 2: 6, 3: 8, 4: 10, 5: 11, 6: 13, 7: 11 };
  // Built-in OpenStreetMap seamarks (band 0): each object has its own minimum zoom instead of SCAMIN.
  const BUILTIN_MIN_ZOOM = 6;
  const show = { enc: true, builtin: true };

  function builtinMinZoom(c, a) {
    if (c === 'LIGHTS') {
      const r = num(a.VALNMR) || 0;
      return r >= 18 ? 6 : r >= 12 ? 8 : r >= 7 ? 10 : 11;
    }
    if (c === 'LITVES' || c === 'LITFLT') return 8;
    if (c.startsWith('BOY') || c.startsWith('BCN')) return 12;
    if (c === 'WRECKS' || c === 'UWTROC' || c === 'OBSTRN') return 11;
    if (c === 'HRBFAC' || c === 'ACHARE' || c === 'PILBOP') return 9;
    return 12;
  }

  const PALETTES = {
    day: {
      depIT: '#a3c98d', depVS: '#6fb2e8', depMS: '#9ccaf0', depMD: '#c3dceb', depDW: '#e8f3f5',
      unsurveyed: '#c7c7c7', land: '#d6c38f', builtUp: '#b9a473', water: '#9ccaf0',
      coast: '#3a3a3a', contour: '#6f8794', safety: '#111111', chart: '#1e1e1e', grey: '#6b6b6b',
      magenta: '#c0189b', sounding: '#7c8a93', soundingShallow: '#111111', text: '#1d1d1d', halo: 'rgba(255,255,255,0.8)',
      red: '#e8202b', green: '#1a9a4b', white: '#f1e24a', yellow: '#f1d900', black: '#141414', orange: '#ff8c00', blue: '#2a5bd7',
      danger: '#c0189b', light: '#e0006a',
    },
    night: {
      depIT: '#0d3324', depVS: '#0c4466', depMS: '#082f4a', depMD: '#051d30', depDW: '#020c16',
      unsurveyed: '#151a1f', land: '#0b1119', builtUp: '#141b26', water: '#0a3550',
      coast: '#00e5ff', contour: 'rgba(0,229,255,0.35)', safety: '#e8f6ff', chart: '#9fd8ee', grey: '#4f6c7c',
      magenta: '#ff3df2', sounding: '#4f7d93', soundingShallow: '#d7f3ff', text: '#bfe8f7', halo: 'rgba(1,7,11,0.85)',
      red: '#ff3b47', green: '#2cff8e', white: '#ffe95c', yellow: '#ffe24a', black: '#5a6a75', orange: '#ff9a2e', blue: '#4d8dff',
      danger: '#ff3df2', light: '#ff3df2',
    },
    red: {
      depIT: '#1c0503', depVS: '#2a0705', depMS: '#1c0403', depMD: '#120202', depDW: '#070000',
      unsurveyed: '#100303', land: '#000000', builtUp: '#0c0101', water: '#2a0705',
      coast: '#c41a12', contour: 'rgba(255,40,30,0.3)', safety: '#ff4a3a', chart: '#a8120a', grey: '#5a0f0a',
      magenta: '#ff3020', sounding: '#7a1a12', soundingShallow: '#ff5a48', text: '#d42a1c', halo: 'rgba(0,0,0,0.85)',
      red: '#ff3020', green: '#a8120a', white: '#ff6a50', yellow: '#ff6a50', black: '#3a0805', orange: '#ff5030', blue: '#801008',
      danger: '#ff3020', light: '#ff3020',
    },
  };
  let P = PALETTES.night;
  let theme = 'night';

  // Mariner's settings (metres), as on an ECDIS.
  const S = { shallow: 2, safety: 10, deep: 30, soundings: true, text: true, lightText: true, other: true };

  const COLOUR = { 1: 'white', 2: 'black', 3: 'red', 4: 'green', 5: 'blue', 6: 'yellow', 7: 'grey', 8: 'brown', 9: 'yellow', 10: 'magenta', 11: 'orange', 12: 'magenta', 13: 'red' };
  const COLOUR_ABBR = { 1: 'W', 3: 'R', 4: 'G', 5: 'Bu', 6: 'Y', 9: 'Am', 10: 'Vi', 11: 'Or' };
  const LITCHR = {
    1: 'F', 2: 'Fl', 3: 'LFl', 4: 'Q', 5: 'VQ', 6: 'UQ', 7: 'Iso', 8: 'Oc', 9: 'IQ', 10: 'IVQ', 11: 'IUQ', 12: 'Mo',
    13: 'FFl', 14: 'Fl+LFl', 15: 'OcFl', 16: 'FLFl', 17: 'Al.Oc', 18: 'Al.LFl', 19: 'Al.Fl', 20: 'Al.Gr', 25: 'Q+LFl', 26: 'VQ+LFl', 27: 'UQ+LFl', 28: 'Al', 29: 'Al.FFl',
  };
  const NATSUR = { 1: 'M', 2: 'Cy', 3: 'Si', 4: 'S', 5: 'St', 6: 'G', 7: 'P', 8: 'Cb', 9: 'R', 11: 'Lv', 14: 'Co', 17: 'Sh', 18: 'Bo' };

  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  const list = (v) => (v ? String(v).split(',').filter(Boolean) : []);
  const colourOf = (code) => P[COLOUR[code]] || P[code] || P.grey;

  // --- Cells ---

  const cells = new Map(); // name -> { info, loaded: { geo, pts, features } | null, loading, used }
  let loadCell = null;
  let onLoaded = () => {};

  function prepare(name, data, builtin) {
    const areaLines = [];
    const points = [];
    const picks = [];
    const contours = new Set();
    for (const f of data.features) {
      const p = f.properties;
      const g = f.geometry;
      if (p.c === 'SOUNDG' && g.type === 'MultiPoint') {
        for (const c of g.coordinates) {
          const s = { type: 'Feature', geometry: { type: 'Point', coordinates: [c[0], c[1]] }, properties: { c: 'SOUNDG', d: c[2], a: p.a } };
          points.push(s);
        }
        continue;
      }
      if (g.type === 'Point') {
        if (builtin) p.mz = builtinMinZoom(p.c, p.a || {});
        points.push(f);
        picks.push({ f, kind: 0, x: g.coordinates[0], y: g.coordinates[1] });
        continue;
      }
      areaLines.push(f);
      if (p.c === 'DEPCNT' && p.a.VALDCO !== undefined && p.a.VALDCO !== '') contours.add(Number(p.a.VALDCO));
      if (p.ol) continue;
      const box = bbox(g);
      picks.push({ f, kind: g.type === 'Polygon' ? 2 : 1, box });
      // Label / symbol point for named areas and area symbols.
      if (g.type === 'Polygon' && AREA_LABEL[p.c] !== undefined) {
        const at = labelPoint(g.coordinates, box);
        if (at) points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { c: '_area', of: p.c, a: p.a } });
      }
    }
    // S-52 isolated dangers: a danger shallower than the safety contour lying in water deeper than
    // it. Keep the depth of the surrounding depth area with each danger.
    const depthAreas = picks.filter((pk) => pk.kind === 2 && pk.f.properties.c === 'DEPARE');
    for (const pk of picks) {
      const c = pk.f.properties.c;
      if (pk.kind !== 0 || (c !== 'UWTROC' && c !== 'WRECKS' && c !== 'OBSTRN')) continue;
      const env = depthAreas.find((d) => pk.x >= d.box[0] && pk.x <= d.box[2] && pk.y >= d.box[1] && pk.y <= d.box[3] &&
        polyContains(d.f.geometry.coordinates, pk.x, pk.y));
      if (env) pk.f.properties.env = num(env.f.properties.a.DRVAL1);
    }
    const opts = { maxZoom: INDEX_MAX_ZOOM, extent: EXTENT, tolerance: 1.5 };
    return {
      geo: geojsonvt({ type: 'FeatureCollection', features: areaLines }, { ...opts, buffer: 128 }),
      pts: geojsonvt({ type: 'FeatureCollection', features: points }, { ...opts, buffer: 2560 }),
      picks,
      name,
      contours: [...contours].sort((a, b) => a - b),
    };
  }

  function bbox(g) {
    let w = 180, s = 90, e = -180, n = -90;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        if (c[0] < w) w = c[0];
        if (c[0] > e) e = c[0];
        if (c[1] < s) s = c[1];
        if (c[1] > n) n = c[1];
      } else c.forEach(walk);
    };
    walk(g.coordinates);
    return [w, s, e, n];
  }

  function ringContains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // Even-odd over all rings, as the polygons are filled.
  const polyContains = (rings, x, y) => rings.reduce((inside, r) => (ringContains(r, x, y) ? !inside : inside), false);

  function labelPoint(rings, [w, s, e, n]) {
    const cx = (w + e) / 2, cy = (s + n) / 2;
    if (polyContains(rings, cx, cy)) return [cx, cy];
    // Scan a horizontal line through the middle for the widest inside span.
    const xs = [];
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i];
        const [xj, yj] = r[j];
        if ((yi > cy) !== (yj > cy)) xs.push(((xj - xi) * (cy - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((a, b) => a - b);
    let best = null, width = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > width) { width = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, cy]; }
    }
    return best;
  }

  // Built-in seamark squares are stored compactly: { k: [classes], f: [[class, lon, lat, attrs?]] }.
  function expand(data) {
    if (!data.f) return data;
    return {
      type: 'FeatureCollection',
      features: data.f.map((r, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r[1], r[2]] }, properties: { c: data.k[r[0]], a: r[3] || {}, id: i } })),
    };
  }

  async function ensure(name) {
    const c = cells.get(name);
    if (!c) return null;
    c.used = performance.now();
    if (c.loaded) return c.loaded;
    if (!c.loading) {
      c.loading = loadCell(name)
        .then((json) => {
          c.loaded = prepare(name, expand(JSON.parse(json)), c.info.builtin);
          evict();
          return c.loaded;
        })
        .catch((err) => {
          console.warn(`ENC ${name}: ${err.message}`);
          c.failed = true;
          return null;
        })
        .finally(() => { c.loading = null; });
    }
    return c.loading;
  }

  function evict() {
    const loaded = [...cells.values()].filter((c) => c.loaded);
    if (loaded.length <= MAX_LOADED) return;
    loaded.sort((a, b) => a.used - b.used);
    for (const c of loaded.slice(0, loaded.length - MAX_LOADED)) c.loaded = null;
  }

  // Cells for a geographic box at a zoom, in drawing order (small scale first).
  function cellsFor(w, s, e, n, z) {
    const out = [];
    for (const c of cells.values()) {
      const i = c.info;
      if (c.failed || !i.bbox || !(i.builtin ? show.builtin : show.enc)) continue;
      if (z < (i.builtin ? BUILTIN_MIN_ZOOM : BAND_MIN_ZOOM[i.band] ?? 9)) continue;
      const [cw, cs, ce, cn] = i.bbox;
      if (ce < w || cw > e || cn < s || cs > n) continue;
      out.push(c);
    }
    return out.sort((a, b) => (a.info.band - b.info.band) || ((b.info.scale || 0) - (a.info.scale || 0)));
  }

  // --- Presentation ---

  function depthColour(d1, d2) {
    const lo = d1 ?? -1;
    const hi = d2 ?? lo;
    if (lo < 0 && hi <= 0) return P.depIT;
    if (lo < S.shallow) return P.depVS;
    if (lo < S.safety) return P.depMS;
    if (lo < S.deep) return P.depMD;
    return P.depDW;
  }

  // Display scale (1:n) at a zoom and latitude, for SCAMIN.
  const displayScale = (z, lat) => (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** z / 0.000264583;

  const MAGENTA_AREAS = new Set(['RESARE', 'CTNARE', 'MIPARE', 'ACHARE', 'CBLARE', 'PIPARE', 'DMPGRD', 'SPLARE', 'MARCUL', 'FSHFAC',
    'OSPARE', 'ICNARE', 'PRCARE', 'ISTZNE', 'TSSRON', 'TSSCRS', 'TESARE', 'SUBTLN', 'FRPARE', 'ADMARE', 'EXEZNE', 'TERRMS', 'CUSZNE', 'CONZNE', 'HRBARE', 'LOGPON', 'ACHBRT', 'BERTHS', 'SEAPLA']);
  const QUIET_AREAS = new Set(['ADMARE', 'EXEZNE', 'TERRMS', 'CUSZNE', 'CONZNE', 'HRBARE', 'SEAPLA']);
  // Class -> text/symbol drawn at an area's label point ('' = name only).
  const AREA_LABEL = {
    SEAARE: '', LNDRGN: '', ACHARE: '⚓', RESARE: '', CTNARE: '!', MIPARE: '', DMPGRD: '', FAIRWY: '', TSSLPT: '→', PRCARE: '!',
    MARCUL: '', ISTZNE: '', BUAARE: '', DRGARE: '', HRBARE: '', ACHBRT: '⚓', BERTHS: '', DOCARE: '', LOKBSN: '', SPLARE: '', CBLARE: '', PIPARE: '',
  };

  function drawPath(ctx, f, scale) {
    ctx.beginPath();
    for (const ring of f.geometry) {
      for (let i = 0; i < ring.length; i++) {
        const x = ring[i][0] * scale, y = ring[i][1] * scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (f.type === 3) ctx.closePath();
    }
  }

  function stroke(ctx, colour, width, dash = []) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.stroke();
  }

  function fillArea(ctx, f, colour) {
    ctx.fillStyle = colour;
    ctx.fill('evenodd');
  }

  // Pass 1: area fills.
  function drawFills(ctx, t, scale) {
    for (const f of t.features) {
      if (f.type !== 3) continue;
      const p = f.tags;
      const a = p.a;
      let colour = null;
      switch (p.c) {
        case 'DEPARE': case 'DRGARE': colour = depthColour(num(a.DRVAL1), num(a.DRVAL2)); break;
        case 'UNSARE': colour = P.unsurveyed; break;
        case 'LNDARE': case 'CAUSWY': case 'PONTON': case 'HULKES': case 'FLODOC': case 'DRYDOC': case 'SLCONS': case 'BRIDGE': colour = P.land; break;
        case 'BUAARE': case 'BUISGL': colour = P.builtUp; break;
        case 'LAKARE': case 'RIVERS': case 'CANALS': case 'DOCARE': case 'LOKBSN': colour = P.water; break;
        case 'TSEZNE': colour = withAlpha(P.magenta, 0.22); break;
        default: break;
      }
      if (!colour) continue;
      drawPath(ctx, f, scale);
      fillArea(ctx, f, colour);
    }
  }

  // Pass 2: lines and area boundaries.
  function drawLines(ctx, t, scale, z, safetyContour) {
    for (const f of t.features) {
      const p = f.tags;
      const a = p.a;
      const area = f.type === 3;
      if (area && p.ns) continue; // drawn by its outline feature
      drawPath(ctx, f, scale);
      switch (p.c) {
        case 'DEPCNT': {
          const v = num(a.VALDCO);
          const safety = v != null && v === safetyContour;
          stroke(ctx, safety ? P.safety : P.contour, safety ? 2 : 0.8);
          break;
        }
        case 'DEPARE': case 'M_COVR': case 'M_QUAL': case 'M_NSYS': case 'M_NPUB': case 'M_ACCY': case 'M_CSCL': case 'M_HOPA': case 'M_SDAT': case 'M_SREL': case 'M_VDAT': case 'TSEZNE':
          if (p.c === 'TSEZNE') stroke(ctx, withAlpha(P.magenta, 0.6), 0.8);
          break;
        case 'COALNE': case 'SLCONS': case 'LNDARE':
          if (p.c === 'LNDARE' && area) break;
          stroke(ctx, P.coast, theme === 'night' ? 1.3 : 1.1);
          break;
        case 'DRGARE': stroke(ctx, P.grey, 0.8, [2, 3]); break;
        case 'UNSARE': stroke(ctx, P.grey, 0.8); break;
        case 'BRIDGE': case 'CAUSWY': case 'PONTON': case 'DAMCON': case 'GATCON': case 'FLODOC': case 'HULKES': case 'DRYDOC': case 'MORFAC':
          stroke(ctx, P.chart, area ? 1 : 2.2);
          break;
        case 'CBLSUB': case 'CBLOHD': case 'PIPSOL': case 'PIPOHD':
          if (!S.other) break;
          stroke(ctx, P.magenta, 1, p.c.startsWith('CBL') ? [6, 3, 1, 3] : [7, 4]);
          break;
        case 'NAVLNE': stroke(ctx, P.chart, 1, [8, 5]); break;
        case 'RECTRC': case 'DWRTCL': stroke(ctx, P.chart, 1.4, p.c === 'DWRTCL' ? [12, 4] : []); break;
        case 'TSELNE': stroke(ctx, withAlpha(P.magenta, 0.7), 5); break;
        case 'TSSBND': stroke(ctx, P.magenta, 1.6, [10, 5]); break;
        case 'FAIRWY': case 'DWRTPT': case 'RCRTCL': case 'TWRTPT': stroke(ctx, P.grey, 1, [10, 4]); break;
        case 'RIVERS': case 'CANALS': if (!area) stroke(ctx, P.water === P.depVS ? P.contour : P.coast, 0.8); break;
        case 'ROADWY': case 'RAILWY': case 'RUNWAY': case 'FNCLNE': case 'LNDELV': case 'SLOTOP': case 'DYKCON': case 'TUNNEL': case 'CONVYR':
          if (!S.other || z < 12) break;
          stroke(ctx, P.grey, 0.7, p.c === 'RAILWY' ? [4, 2] : []);
          break;
        case 'OBSTRN': case 'WRECKS': case 'UWTROC':
          stroke(ctx, P.danger, 1, [2, 2]);
          break;
        case 'BUAARE': case 'BUISGL': case 'LAKARE': case 'LNDRGN': case 'SEAARE': case 'LNDMRK': case 'SBDARE': case 'WEDKLP': break;
        default:
          if (MAGENTA_AREAS.has(p.c)) {
            if (QUIET_AREAS.has(p.c) && z < 12) break;
            stroke(ctx, withAlpha(P.magenta, QUIET_AREAS.has(p.c) ? 0.45 : 0.85), 1.1, [9, 4]);
          } else if (!area) {
            stroke(ctx, P.grey, 0.7);
          }
      }
    }
  }

  function withAlpha(hex, a) {
    if (!hex.startsWith('#')) return hex;
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgba(${v[0]},${v[1]},${v[2]},${a})`;
  }

  // --- Point symbols ---

  function text(ctx, str, x, y, { size = 11, colour = P.text, align = 'left', italic = false, bold = false, halo = true, base = 'middle' } = {}) {
    ctx.font = `${italic ? 'italic ' : ''}${bold ? '600 ' : ''}${size}px "Space Grotesk", sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = base;
    if (halo) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = P.halo;
      ctx.setLineDash([]);
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = colour;
    ctx.fillText(str, x, y);
  }

  // Sounding: whole metres with tenths as a subscript below 31 m, as on paper charts.
  function drawSounding(ctx, d, x, y) {
    const colour = d <= S.safety ? P.soundingShallow : P.sounding;
    const whole = Math.floor(Math.abs(d));
    const tenth = Math.round((Math.abs(d) - whole) * 10) % 10;
    const main = String(whole);
    ctx.font = '10.5px "Space Grotesk", sans-serif';
    const w = ctx.measureText(main).width;
    const sub = Math.abs(d) < 31 && tenth ? String(tenth) : '';
    const total = w + (sub ? 6 : 0);
    text(ctx, main, x - total / 2, y, { size: 10.5, colour, halo: theme !== 'day' });
    if (sub) text(ctx, sub, x - total / 2 + w + 0.5, y + 4, { size: 8, colour, halo: theme !== 'day' });
    if (d < 0) { // drying height: underline
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - total / 2, y + 7);
      ctx.lineTo(x + total / 2, y + 7);
      ctx.stroke();
    }
  }

  function fillColours(ctx, codes, path, horizontal = true, box = [-6, -6, 12, 12]) {
    const cs = codes.length ? codes : ['7'];
    ctx.save();
    path();
    ctx.clip();
    const [bx, by, bw, bh] = box;
    cs.forEach((c, i) => {
      ctx.fillStyle = colourOf(c);
      if (horizontal) ctx.fillRect(bx, by + (bh * i) / cs.length, bw, bh / cs.length + 0.5);
      else ctx.fillRect(bx + (bw * i) / cs.length, by, bw / cs.length + 0.5, bh);
    });
    ctx.restore();
  }

  // Buoy: S-52 style simplified shapes leaning right, filled in the buoy colours.
  function drawBuoy(ctx, a, x, y) {
    const shape = num(a.BOYSHP) || 4;
    const cols = list(a.COLOUR);
    const vertical = list(a.COLPAT).includes('2');
    ctx.save();
    ctx.translate(x, y);
    // Base line (the waterline position).
    ctx.strokeStyle = P.chart;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(6, 0);
    ctx.stroke();
    ctx.rotate(0.35);
    let path;
    if (shape === 1) path = () => { ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(5, 0); ctx.lineTo(0, -12); ctx.closePath(); };
    else if (shape === 2) path = () => { ctx.beginPath(); ctx.rect(-4.5, -10, 9, 10); };
    else if (shape === 3) path = () => { ctx.beginPath(); ctx.arc(0, -5.5, 5.5, 0, Math.PI * 2); };
    else if (shape === 5) path = () => { ctx.beginPath(); ctx.rect(-1.8, -14, 3.6, 14); };
    else if (shape === 6) path = () => { ctx.beginPath(); ctx.ellipse(0, -4, 6.5, 4, 0, 0, Math.PI * 2); };
    else if (shape === 7) path = () => { ctx.beginPath(); ctx.rect(-7, -9, 14, 9); };
    else path = () => { ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(4, 0); ctx.lineTo(1.5, -14); ctx.lineTo(-1.5, -14); ctx.closePath(); };
    fillColours(ctx, cols, path, !vertical, [-8, -15, 16, 16]);
    path();
    ctx.strokeStyle = P.chart;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    // Cardinal topmark (two cones) for cardinal buoys.
    if (a._cardinal) drawCardinalTop(ctx, a._cardinal, x + 6, y - 18);
  }

  function drawCardinalTop(ctx, cat, x, y) {
    const cone = (up, dy) => {
      ctx.beginPath();
      if (up) { ctx.moveTo(x - 3.5, y + dy + 3); ctx.lineTo(x + 3.5, y + dy + 3); ctx.lineTo(x, y + dy - 3); }
      else { ctx.moveTo(x - 3.5, y + dy - 3); ctx.lineTo(x + 3.5, y + dy - 3); ctx.lineTo(x, y + dy + 3); }
      ctx.closePath();
      ctx.fillStyle = P.chart;
      ctx.fill();
    };
    // N: both up; S: both down; E: up then down (base to base); W: down then up (point to point).
    const top = { 1: [true, true], 2: [true, false], 3: [false, false], 4: [false, true] }[cat] || [true, true];
    cone(top[0], -4);
    cone(top[1], 4);
  }

  function drawBeacon(ctx, a, x, y) {
    const shape = num(a.BCNSHP) || 1;
    const cols = list(a.COLOUR);
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = P.chart;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
    ctx.stroke();
    if (shape === 3 || shape === 4) {
      const path = () => { ctx.beginPath(); ctx.moveTo(-4, -1.5); ctx.lineTo(4, -1.5); ctx.lineTo(2, -14); ctx.lineTo(-2, -14); ctx.closePath(); };
      fillColours(ctx, cols, path, true, [-5, -15, 10, 14]);
      path();
      ctx.stroke();
    } else {
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = colourOf(cols[0] || '2');
      ctx.beginPath();
      ctx.moveTo(0, -2);
      ctx.lineTo(0, -15);
      ctx.stroke();
    }
    ctx.restore();
    if (a._cardinal) drawCardinalTop(ctx, a._cardinal, x, y - 21);
  }

  function lightColour(cols) {
    const c = cols[0];
    if (c === '3') return P.red;
    if (c === '4') return P.green;
    if (c === '1' || c === '6' || c === '11' || !c) return P.white;
    return P.light;
  }

  function lightDescription(a) {
    const chr = LITCHR[a.LITCHR] || '';
    const grp = a.SIGGRP && a.SIGGRP !== '(1)' && a.SIGGRP !== '()' ? a.SIGGRP : '';
    const cols = list(a.COLOUR).map((c) => COLOUR_ABBR[c]).filter(Boolean).join('');
    const per = num(a.SIGPER) ? `${num(a.SIGPER)}s` : '';
    const h = num(a.HEIGHT) ? `${num(a.HEIGHT)}m` : '';
    const r = num(a.VALNMR) ? `${num(a.VALNMR)}M` : '';
    return [`${chr}${grp}`, cols, per, h, r].filter(Boolean).join(' ');
  }

  function drawLight(ctx, a, x, y, z) {
    const cols = list(a.COLOUR);
    const colour = lightColour(cols);
    const s1 = num(a.SECTR1), s2 = num(a.SECTR2);
    ctx.setLineDash([]);
    if (s1 != null && s2 != null) {
      // Sector light: legs from the light, arc between them (bearings are from seaward).
      const toCanvas = (bearing) => ((bearing + 180 - 90) * Math.PI) / 180;
      const a1 = toCanvas(s1), a2 = toCanvas(s2 < s1 ? s2 + 360 : s2);
      const r = z >= 14 ? 26 : 20;
      ctx.strokeStyle = P.chart;
      ctx.lineWidth = 0.8;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (const ang of [a1, a2]) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * r * 2, y + Math.sin(ang) * r * 2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = P.chart;
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.arc(x, y, r, a1, a2);
      ctx.stroke();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 3;
      ctx.stroke();
      return;
    }
    // All-round light: the classic flare.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((135 * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-5, -6, -5, -14, 0, -17);
    ctx.bezierCurveTo(5, -14, 5, -6, 0, 0);
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.95;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = P.chart;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();
  }

  function drawDanger(ctx, p, x, y, z) {
    const a = p.a;
    const depth = num(a.VALSOU);
    const deepWater = p.env == null || p.env >= S.safety;
    // Built-in OSM dangers (p.mz) carry no surrounding depth area: only a known depth counts.
    const isolated = p.mz ? depth != null && depth < S.safety
      : deepWater && (depth != null ? depth < S.safety : num(a.WATLEV) === 3);
    if (!isolated && z < 13) return; // ordinary rocks and wrecks only when zoomed in
    ctx.setLineDash([]);
    if (isolated) {
      // S-52 isolated danger: magenta circle with a cross.
      ctx.strokeStyle = P.danger;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.moveTo(x - 4.5, y - 4.5); ctx.lineTo(x + 4.5, y + 4.5);
      ctx.moveTo(x + 4.5, y - 4.5); ctx.lineTo(x - 4.5, y + 4.5);
      ctx.stroke();
      return;
    }
    if (p.c === 'WRECKS') {
      ctx.strokeStyle = P.chart;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y);
      ctx.moveTo(x - 3, y - 4); ctx.lineTo(x - 3, y + 4);
      ctx.moveTo(x + 3, y - 4); ctx.lineTo(x + 3, y + 4);
      ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6);
      ctx.stroke();
      return;
    }
    if (p.c === 'UWTROC') {
      ctx.strokeStyle = P.chart;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x - 4.5, y); ctx.lineTo(x + 4.5, y);
      ctx.moveTo(x, y - 4.5); ctx.lineTo(x, y + 4.5);
      if (num(a.WATLEV) === 4 || num(a.WATLEV) === 5) { // covers and uncovers / awash: add diagonals
        ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3);
        ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3);
      }
      ctx.stroke();
      return;
    }
    // Obstruction: dotted circle.
    ctx.strokeStyle = P.chart;
    ctx.lineWidth = 1;
    ctx.setLineDash([1.5, 2]);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (depth != null) drawSounding(ctx, depth, x, y);
  }

  function simpleMark(ctx, x, y, colour, kind) {
    ctx.setLineDash([]);
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (kind === 'square') ctx.rect(x - 3.5, y - 3.5, 7, 7);
    else if (kind === 'dot') ctx.arc(x, y, 1.8, 0, Math.PI * 2);
    else ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    if (kind === 'dot' || kind === 'square-fill') ctx.fill(); else ctx.stroke();
    if (kind === 'landmark') {
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const shortName = (name) => {
    if (!name) return '';
    const m = /(?:buoy|beacon|light|daybeacon|lighted buoy)\s+(\S+)\s*$/i.exec(name) || /\b(\d+[A-Z]?|[A-Z]{1,2})\s*$/.exec(name);
    return m ? `"${m[1]}"` : '';
  };

  // Pass 3: point symbols and text; returns nothing, uses `placed` to avoid overlapping text.
  function drawPoints(ctx, t, scale, z, scaleDenom, placed, offX, offY) {
    const feats = t.features.slice().sort((a, b) => (PRIORITY[a.tags.c] || 5) - (PRIORITY[b.tags.c] || 5));
    const fits = (x, y, w, h) => {
      if (placed.some((r) => x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1])) return false;
      placed.push([x, y, w, h]);
      return true;
    };
    for (const f of feats) {
      const p = f.tags;
      const a = p.a || {};
      const scamin = num(a.SCAMIN);
      if (scamin && scaleDenom > scamin) continue;
      if (p.mz && z < p.mz) continue;
      // Built-in seamarks can be dense (Baltic skerries): until zoom 14 skip buoys and beacons that would overlap.
      const thin = p.mz && z < 14 && (p.c.startsWith('BOY') || p.c.startsWith('BCN') || (p.c === 'LIGHTS' && p.mz > 8));
      for (const pt of f.geometry) {
        const x = pt[0] * scale, y = pt[1] * scale;
        if (x - offX < -128 || y - offY < -128 || x - offX > 384 || y - offY > 384) continue;
        if (thin && !fits(x - 6, y - 15, 13, 17)) continue;
        switch (p.c) {
          case 'SOUNDG':
            if (S.soundings && z >= 12 && fits(x - 7, y - 6, 14, 12)) drawSounding(ctx, p.d, x, y);
            break;
          case 'BOYLAT': case 'BOYCAR': case 'BOYISD': case 'BOYSAW': case 'BOYSPP': case 'BOYINB': {
            const aa = p.c === 'BOYCAR' ? { ...a, _cardinal: num(a.CATCAM) } : a;
            drawBuoy(ctx, aa, x, y);
            const label = shortName(a.OBJNAM);
            if (S.text && label && z >= 13 && fits(x + 8, y - 4, label.length * 6, 11)) text(ctx, label, x + 9, y + 2, { size: 10 });
            break;
          }
          case 'BCNLAT': case 'BCNCAR': case 'BCNISD': case 'BCNSAW': case 'BCNSPP': {
            const aa = p.c === 'BCNCAR' ? { ...a, _cardinal: num(a.CATCAM) } : a;
            drawBeacon(ctx, aa, x, y);
            const label = shortName(a.OBJNAM);
            if (S.text && label && z >= 13 && fits(x + 6, y - 6, label.length * 6, 11)) text(ctx, label, x + 6, y - 1, { size: 10 });
            break;
          }
          case 'LIGHTS':
            drawLight(ctx, a, x, y, z);
            // Major lights get their characteristic (and name) earlier than minor ones.
            if (S.lightText && (z >= 13 || (p.mz && z >= p.mz + 3))) {
              const desc = lightDescription(a);
              if (desc && fits(x + 10, y + 4, desc.length * 5.6, 11)) text(ctx, desc, x + 10, y + 10, { size: 9.5 });
              if (S.text && a.OBJNAM && p.mz && p.mz <= 8 && fits(x + 10, y - 10, a.OBJNAM.length * 5.6, 11)) {
                text(ctx, a.OBJNAM, x + 10, y - 4, { size: 9.5, italic: true });
              }
            }
            break;
          case 'LITVES': case 'LITFLT':
            drawBuoy(ctx, { BOYSHP: '7', COLOUR: a.COLOUR || '3' }, x, y);
            if (S.text && a.OBJNAM && z >= 10 && fits(x + 9, y - 4, a.OBJNAM.length * 5.6, 11)) text(ctx, a.OBJNAM, x + 9, y + 2, { size: 9.5 });
            break;
          case 'HRBFAC': case 'SMCFAC':
            text(ctx, '⚓', x, y, { size: z >= 12 ? 13 : 11, colour: P.chart, align: 'center' });
            if (S.text && a.OBJNAM && z >= 12 && fits(x + 8, y - 6, a.OBJNAM.length * 5.6, 12)) text(ctx, a.OBJNAM, x + 9, y, { size: 9.5, italic: true });
            break;
          case 'ACHARE':
            text(ctx, '⚓', x, y, { size: 13, colour: P.magenta, align: 'center' });
            break;
          case 'PILBOP':
            simpleMark(ctx, x, y, P.magenta, 'circle');
            if (z >= 11) text(ctx, 'Pilot', x + 7, y, { size: 9.5, colour: P.magenta });
            break;
          case 'UWTROC': case 'WRECKS': case 'OBSTRN': drawDanger(ctx, p, x, y, z); break;
          case 'FOGSIG':
            ctx.strokeStyle = P.magenta; ctx.lineWidth = 1; ctx.setLineDash([]);
            for (const r of [6, 9, 12]) { ctx.beginPath(); ctx.arc(x, y, r, -2.4, -1.6); ctx.stroke(); }
            break;
          case 'RTPBCN': case 'RDOSTA': case 'RADSTA': case 'RSCSTA': case 'CGUSTA':
            simpleMark(ctx, x, y, P.magenta, 'circle');
            break;
          case 'LNDMRK': case 'SILTNK': case 'BUISGL': case 'CRANES':
            if (!S.other) break;
            simpleMark(ctx, x, y, a.CONVIS === '1' ? P.chart : P.grey, p.c === 'BUISGL' ? 'square' : 'landmark');
            if (S.text && a.OBJNAM && a.CONVIS === '1' && z >= 14 && fits(x + 6, y - 6, a.OBJNAM.length * 5.5, 11)) {
              text(ctx, a.OBJNAM, x + 7, y, { size: 9.5, colour: P.grey });
            }
            break;
          case 'PILPNT': case 'MORFAC': case 'DAYMAR': case 'TOPMAR':
            if (p.c === 'TOPMAR') break;
            simpleMark(ctx, x, y, P.chart, p.c === 'DAYMAR' ? 'square' : 'dot');
            break;
          case 'SBDARE':
            if (S.other && S.text && z >= 13) {
              const s = list(a.NATSUR).map((c) => NATSUR[c]).filter(Boolean).join('.');
              if (s && fits(x - 6, y - 6, s.length * 6, 12)) text(ctx, s, x, y, { size: 10, italic: true, colour: P.grey, align: 'center', halo: false });
            }
            break;
          case '_area': drawAreaLabel(ctx, p, x, y, z, fits); break;
          case 'ACHBRT': text(ctx, '⚓', x, y, { size: 12, colour: P.magenta, align: 'center' }); break;
          case 'SOUNDG_': break;
          default:
            if (p.c.startsWith('M_') || p.c === 'MAGVAR' || p.c === 'C_AGGR' || p.c === 'C_ASSO') break;
            if (S.other && z >= 13) simpleMark(ctx, x, y, P.grey, 'dot');
        }
      }
    }
  }

  const PRIORITY = { _area: 0, SOUNDG: 1, SBDARE: 1, LNDMRK: 3, BUISGL: 3, UWTROC: 6, WRECKS: 6, OBSTRN: 6, LIGHTS: 8, BOYLAT: 9, BOYCAR: 9, BOYSAW: 9, BOYISD: 9, BOYSPP: 9, BCNLAT: 9, BCNCAR: 9 };

  function drawAreaLabel(ctx, p, x, y, z, fits) {
    const sym = AREA_LABEL[p.of];
    const a = p.a || {};
    if (p.of === 'TSSLPT') {
      const o = num(a.ORIENT);
      if (o == null || z < 10) return;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(((o - 90) * Math.PI) / 180);
      ctx.fillStyle = withAlpha(P.magenta, 0.75);
      ctx.beginPath();
      ctx.moveTo(-16, -3); ctx.lineTo(6, -3); ctx.lineTo(6, -8); ctx.lineTo(18, 0); ctx.lineTo(6, 8); ctx.lineTo(6, 3); ctx.lineTo(-16, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }
    if (sym && z >= 11) text(ctx, sym, x, y, { size: 13, colour: P.magenta, align: 'center', bold: true });
    if (!S.text || !a.OBJNAM) return;
    const big = p.of === 'SEAARE' || p.of === 'LNDRGN';
    if ((big && z < 11) || (!big && z < 13)) return;
    const name = a.OBJNAM;
    const w = name.length * (big ? 6.5 : 5.6);
    if (!fits(x - w / 2, y + (sym ? 8 : -6), w, 12)) return;
    text(ctx, name, x, y + (sym ? 14 : 0), {
      size: big ? 11 : 9.5, italic: true, align: 'center',
      colour: p.of === 'LNDRGN' || p.of === 'BUAARE' ? P.grey : MAGENTA_AREAS.has(p.of) ? P.magenta : P.text,
    });
  }

  const EncLayer = L.GridLayer.extend({
    options: { tileSize: 256, maxZoom: 18, zIndex: 4, attribution: 'Seamarks © OpenStreetMap contributors (ODbL) · ENC: official S-57 charts · not for navigation' },

    createTile(coords, done) {
      const size = this.getTileSize();
      const tile = document.createElement('canvas');
      const ratio = window.devicePixelRatio || 1;
      tile.width = size.x * ratio;
      tile.height = size.y * ratio;
      const map = this._map;
      const nw = map.unproject([coords.x * size.x, coords.y * size.y], coords.z);
      const se = map.unproject([(coords.x + 1) * size.x, (coords.y + 1) * size.y], coords.z);
      const list = cellsFor(nw.lng - 0.05, se.lat - 0.05, se.lng + 0.05, nw.lat + 0.05, coords.z);
      if (!list.length) {
        setTimeout(() => done(null, tile), 0);
        return tile;
      }
      Promise.all(list.map((c) => ensure(c.info.name))).then((loaded) => {
        const ctx = tile.getContext('2d');
        ctx.scale(ratio, ratio);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const dz = Math.max(0, coords.z - INDEX_MAX_ZOOM);
        const z = coords.z - dz;
        const x = coords.x >> dz, y = coords.y >> dz;
        const scale = (size.x / EXTENT) * 2 ** dz;
        const offX = (coords.x - (x << dz)) * size.x, offY = (coords.y - (y << dz)) * size.y;
        const scaleDenom = displayScale(coords.z, (nw.lat + se.lat) / 2);
        const placed = [];
        ctx.translate(-offX, -offY);
        for (const cell of loaded) {
          if (!cell) continue;
          const t = cell.geo.getTile(z, x, y);
          if (t) {
            drawFills(ctx, t, scale);
            // Safety contour: the shallowest contour of this cell at or deeper than the safety depth.
            const sc = cell.contours.find((v) => v >= S.safety);
            drawLines(ctx, t, scale, coords.z, sc ?? null);
          }
          const tp = cell.pts.getTile(z, x, y);
          if (tp) drawPoints(ctx, tp, scale, coords.z, scaleDenom, placed, offX, offY);
        }
        done(null, tile);
      }).catch((err) => done(err, tile));
      return tile;
    },
  });

  // --- Queries ---

  function loadedCellsAt(lat, lon) {
    const out = [];
    for (const c of cells.values()) {
      if (!c.loaded || !(c.info.builtin ? show.builtin : show.enc)) continue;
      const [w, s, e, n] = c.info.bbox;
      if (lon >= w && lon <= e && lat >= s && lat <= n) out.push(c);
    }
    return out.sort((a, b) => b.info.band - a.info.band);
  }

  // Depth area at a point from the most detailed loaded cell: { from, to, cell } or { land: true }.
  function depthAt(lat, lon) {
    for (const c of loadedCellsAt(lat, lon)) {
      for (const pk of c.loaded.picks) {
        if (pk.kind !== 2) continue;
        const cl = pk.f.properties.c;
        if (cl !== 'DEPARE' && cl !== 'DRGARE' && cl !== 'LNDARE' && cl !== 'UNSARE') continue;
        const [w, s, e, n] = pk.box;
        if (lon < w || lon > e || lat < s || lat > n) continue;
        if (!polyContains(pk.f.geometry.coordinates, lon, lat)) continue;
        if (cl === 'LNDARE') return { land: true, cell: c.info.name };
        if (cl === 'UNSARE') return { unsurveyed: true, cell: c.info.name };
        const a = pk.f.properties.a;
        return { from: num(a.DRVAL1), to: num(a.DRVAL2), cell: c.info.name, dredged: cl === 'DRGARE' };
      }
    }
    return null;
  }

  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Chart objects at a screen point: points within `tol` px, lines within `tol`, areas containing it.
  function pick(map, latlng, tol = 8) {
    const { lat, lng } = latlng.wrap ? latlng.wrap() : latlng;
    const at = map.latLngToContainerPoint([lat, lng]);
    const degTol = Math.abs(map.containerPointToLatLng([at.x + tol, at.y]).lng - lng) + 1e-9;
    const out = [];
    for (const c of loadedCellsAt(lat, lng)) {
      for (const pk of c.loaded.picks) {
        if (pk.kind === 0) {
          if (Math.abs(pk.x - lng) > degTol || Math.abs(pk.y - lat) > degTol) continue;
          const q = map.latLngToContainerPoint([pk.y, pk.x]);
          if (Math.hypot(q.x - at.x, q.y - at.y) <= tol) out.push({ f: pk.f, kind: 0, cell: c.info.name });
          continue;
        }
        const [w, s, e, n] = pk.box;
        if (lng < w - degTol || lng > e + degTol || lat < s - degTol || lat > n + degTol) continue;
        const g = pk.f.geometry;
        if (pk.kind === 2) {
          if (polyContains(g.coordinates, lng, lat)) out.push({ f: pk.f, kind: 2, cell: c.info.name });
          continue;
        }
        const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
        let hit = false;
        for (const line of lines) {
          for (let i = 1; i < line.length && !hit; i++) {
            const a = map.latLngToContainerPoint([line[i - 1][1], line[i - 1][0]]);
            const b = map.latLngToContainerPoint([line[i][1], line[i][0]]);
            if (segDist(at.x, at.y, a.x, a.y, b.x, b.y) <= tol) hit = true;
          }
        }
        if (hit) out.push({ f: pk.f, kind: 1, cell: c.info.name });
      }
    }
    // Points, then lines, then areas; meta objects (coverage, quality …) last.
    const rank = (h) => h.kind + (h.f.properties.c.startsWith('M_') ? 10 : 0);
    return out.sort((a, b) => rank(a) - rank(b));
  }

  let catalogue = null;
  const classByCode = new Map();
  const attrByCode = new Map();

  // Human-readable description of a picked object.
  function describe(hit) {
    const p = hit.f.properties;
    const cls = classByCode.get(p.c);
    const attrs = [];
    for (const [k, v] of Object.entries(p.a || {})) {
      if (v === '' || v == null) continue;
      const def = attrByCode.get(k);
      const enums = catalogue && catalogue.values[k];
      const value = enums ? String(v).split(',').map((x) => enums[x] || x).join(', ') : v;
      attrs.push({ code: k, name: def ? def[1] : k, value });
    }
    if (p.c === 'LIGHTS') {
      const d = lightDescription(p.a || {});
      if (d) attrs.unshift({ code: '', name: 'Characteristic', value: d });
    }
    const cell = hit.cell.startsWith('OSM_') ? 'OpenStreetMap' : hit.cell;
    return { code: p.c, name: cls ? cls[1] : p.c, title: (p.a && p.a.OBJNAM) || '', attrs, cell, geometry: ['Point', 'Line', 'Area'][hit.kind] };
  }

  // --- API ---

  function createEncLayer(opts) {
    loadCell = opts.loadCell;
    const layer = new EncLayer();
    const api = {
      layer,
      setCells(list) {
        const keep = new Set(list.map((c) => c.name));
        for (const [n, c] of [...cells]) if (!c.info.builtin && !keep.has(n)) cells.delete(n);
        for (const info of list) {
          const old = cells.get(info.name);
          if (old && old.info.imported === info.imported) continue;
          cells.set(info.name, { info, loaded: null, loading: null, used: 0 });
        }
        layer.redraw();
      },
      // Built-in seamark squares: [{ name, bbox, features }].
      setBuiltin(list) {
        for (const sq of list) {
          if (!cells.has(sq.name)) cells.set(sq.name, { info: { ...sq, band: 0, builtin: true }, loaded: null, loading: null, used: 0 });
        }
        layer.redraw();
      },
      setVisible(name, on) {
        show[name] = on;
        layer.redraw();
      },
      cellCount: () => cells.size,
      cellsInView(map) {
        const b = map.getBounds();
        return cellsFor(b.getWest(), b.getSouth(), b.getEast(), b.getNorth(), 99).map((c) => c.info);
      },
      setTheme(name) {
        theme = PALETTES[name] ? name : 'night';
        P = PALETTES[theme];
        layer.redraw();
      },
      settings: () => ({ ...S }),
      setSettings(s) {
        Object.assign(S, s);
        layer.redraw();
      },
      setCatalogue(c) {
        catalogue = c;
        for (const v of Object.values(c.classes)) classByCode.set(v[0], v);
        for (const v of Object.values(c.attributes)) attrByCode.set(v[0], v);
      },
      depthAt,
      pick,
      describe,
      async preload(lat, lon) {
        const list = cellsFor(lon, lat, lon, lat, 99);
        await Promise.all(list.map((c) => ensure(c.info.name)));
      },
    };
    return api;
  }

  window.EncChart = { createEncLayer, lightDescription };
})();
