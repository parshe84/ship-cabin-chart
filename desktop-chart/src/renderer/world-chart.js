'use strict';

// Offline world nautical chart: Natural Earth 1:10m vectors plus ETOPO1-based isobaths,
// sliced with geojson-vt and drawn on canvas tiles. Two looks: neon night and bright day.

(function () {
  const EXTENT = 4096;
  const INDEX_MAX_ZOOM = 14; // deeper zooms reuse z14 geometry, scaled up

  // Isobaths in bathymetry.json (see scripts/build-bathymetry.py); 0 = sea surface.
  const DEPTH_LEVELS = [0, 10, 20, 50, 100, 200, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];

  // Colour for each depth level, interpolated along a ramp of [position 0..1, hex] stops.
  function depthPalette(stops) {
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const out = {};
    DEPTH_LEVELS.forEach((d, i) => {
      const t = i / (DEPTH_LEVELS.length - 1);
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, c0] = stops[k];
      const [t1, c1] = stops[k + 1];
      const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
      const a = hex(c0), b = hex(c1);
      out[d] = '#' + a.map((v, j) => Math.round(v + (b[j] - v) * f).toString(16).padStart(2, '0')).join('');
    });
    return out;
  }

  const THEMES = {
    night: {
      depth: depthPalette([[0, '#12506b'], [0.18, '#0c3650'], [0.35, '#082539'], [0.6, '#051624'], [0.8, '#030c18'], [0.9, '#1c0a3e'], [1, '#4a0c72']]),
      contour: 'rgba(0, 229, 255, 0.16)',
      contourShallow: 'rgba(0, 229, 255, 0.32)',
      ocean: '#01070b',
      land: '#070b12',
      ice: '#0e1824',
      lake: '#0a2a40',
      river: 'rgba(0, 229, 255, 0.28)',
      coast: '#00e5ff',
      coastWidth: 1.1,
      coastGlow: 'rgba(0, 229, 255, 0.9)',
      border: 'rgba(255, 43, 214, 0.5)',
      reef: '#ff2bd6',
      graticule: 'rgba(0, 229, 255, 0.16)',
    },
    day: {
      depth: depthPalette([[0, '#e2fafa'], [0.18, '#a9e6ef'], [0.35, '#6cc7e2'], [0.6, '#3487c4'], [1, '#0b2560']]),
      contour: 'rgba(255, 255, 255, 0.35)',
      contourShallow: 'rgba(20, 90, 140, 0.35)',
      ocean: '#0f2d68',
      land: '#f7f4ed',
      ice: '#ffffff',
      lake: '#a6e4ee',
      river: '#7fcfe6',
      coast: '#1e293b',
      coastWidth: 0.9,
      coastGlow: null,
      border: '#c084fc',
      reef: '#f43f5e',
      graticule: 'rgba(15, 45, 104, 0.22)',
    },
  };
  // Red night vision: everything in dim reds on black, nothing blue or white.
  THEMES.red = {
    depth: depthPalette([[0, '#2a0606'], [0.35, '#1a0303'], [0.7, '#0e0101'], [1, '#050000']]),
    contour: 'rgba(255, 40, 30, 0.14)',
    contourShallow: 'rgba(255, 40, 30, 0.28)',
    ocean: '#050000',
    land: '#000000',
    ice: '#140202',
    lake: '#2a0606',
    river: 'rgba(255, 40, 30, 0.25)',
    coast: '#c41a12',
    coastWidth: 1,
    coastGlow: null,
    border: 'rgba(200, 30, 20, 0.45)',
    reef: '#ff3020',
    graticule: 'rgba(255, 40, 30, 0.14)',
  };
  let P = THEMES.night;
  let showGraticule = true;

  // Draw order; each entry is filled/stroked with the current palette.
  const LAYERS = [
    {
      name: 'bathymetry',
      fill: (p) => P.depth[p.depth] || P.ocean,
      // Isobaths as thin contour lines; shallow ones (the ones that matter near a coast) stronger.
      outline: (p, z) => {
        if (p.depth <= 0 || (p.depth < 200 && z < 5)) return null;
        return p.depth <= 200 ? P.contourShallow : P.contour;
      },
    },
    { name: 'land', fill: () => P.land },
    { name: 'ice', fill: () => P.ice },
    { name: 'lakes', fill: () => P.lake, minZoom: (p) => (p.scalerank || 0) - 2 },
    { name: 'rivers', stroke: () => P.river, width: 1, minZoom: (p) => (p.scalerank || 0) - 4 },
    { name: 'reefs', stroke: () => P.reef, width: 1.2, dash: [2, 3], minZoom: () => 6 },
    { name: 'borders', stroke: () => P.border, width: 1, dash: [6, 3] },
    { name: 'coastline', stroke: () => P.coast, width: () => P.coastWidth, glow: () => P.coastGlow },
  ];

  const indexes = {};

  function graticuleStep(z) {
    if (z <= 2) return 30;
    if (z <= 4) return 10;
    if (z <= 6) return 5;
    if (z <= 8) return 1;
    if (z <= 10) return 0.25;
    if (z <= 12) return 1 / 12; // 5 minutes
    return 1 / 60;
  }

  function drawGeometry(ctx, feature, scale, dx, dy) {
    ctx.beginPath();
    for (const ring of feature.geometry) {
      for (let i = 0; i < ring.length; i++) {
        const x = ring[i][0] * scale - dx;
        const y = ring[i][1] * scale - dy;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (feature.type === 3) ctx.closePath();
    }
  }

  const WorldChartLayer = L.GridLayer.extend({
    options: { tileSize: 256, maxZoom: 18, attribution: 'Natural Earth · ETOPO1 depths (NOAA) via Mapzen Terrarium' },

    createTile(coords) {
      const size = this.getTileSize();
      const tile = document.createElement('canvas');
      const ratio = window.devicePixelRatio || 1;
      tile.width = size.x * ratio;
      tile.height = size.y * ratio;
      const ctx = tile.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.fillStyle = P.depth[0]; // sea surface; deeper bands are drawn on top
      ctx.fillRect(0, 0, size.x, size.y);

      // Zooms deeper than the index: take the ancestor tile and magnify the right part.
      const dz = Math.max(0, coords.z - INDEX_MAX_ZOOM);
      const z = coords.z - dz;
      const x = coords.x >> dz;
      const y = coords.y >> dz;
      const scale = (size.x / EXTENT) * 2 ** dz;
      const dx = (coords.x - (x << dz)) * size.x;
      const dy = (coords.y - (y << dz)) * size.y;

      ctx.lineJoin = 'round';
      for (const layer of LAYERS) {
        const index = indexes[layer.name];
        if (!index) continue;
        const t = index.getTile(z, x, y);
        if (!t) continue;
        const glow = layer.glow && layer.glow();
        ctx.shadowColor = glow || 'transparent';
        ctx.shadowBlur = glow ? 6 : 0;
        for (const f of t.features) {
          if (layer.minZoom && coords.z < layer.minZoom(f.tags)) continue;
          drawGeometry(ctx, f, scale, dx, dy);
          if (layer.fill) {
            ctx.fillStyle = layer.fill(f.tags);
            ctx.fill('evenodd');
            const outline = layer.outline && layer.outline(f.tags, coords.z);
            if (outline) {
              ctx.strokeStyle = outline;
              ctx.lineWidth = 0.7;
              ctx.setLineDash([]);
              ctx.stroke();
            }
          } else {
            ctx.strokeStyle = layer.stroke(f.tags);
            ctx.lineWidth = typeof layer.width === 'function' ? layer.width() : layer.width;
            ctx.setLineDash(layer.dash || []);
            ctx.stroke();
          }
        }
      }
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
      if (showGraticule) this._drawGraticule(ctx, coords, size);
      return tile;
    },

    _drawGraticule(ctx, coords, size) {
      const map = this._map;
      const nw = map.unproject([coords.x * size.x, coords.y * size.y], coords.z);
      const se = map.unproject([(coords.x + 1) * size.x, (coords.y + 1) * size.y], coords.z);
      const step = graticuleStep(coords.z);
      const origin = L.point(coords.x * size.x, coords.y * size.y);
      ctx.strokeStyle = P.graticule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let lon = Math.ceil(nw.lng / step) * step; lon <= se.lng; lon += step) {
        const px = map.project([0, lon], coords.z).x - origin.x;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, size.y);
      }
      for (let lat = Math.ceil(se.lat / step) * step; lat <= nw.lat; lat += step) {
        const py = map.project([lat, 0], coords.z).y - origin.y;
        ctx.moveTo(0, py);
        ctx.lineTo(size.x, py);
      }
      ctx.stroke();
    },
  });

  // --- Labels: oceans & seas, ports, cities (DOM markers, only what is visible) ---

  const labelData = { marine: [], ports: [], places: [] };

  function marineVisible(p, z) {
    const min = p.min_label != null ? p.min_label : (p.scalerank || 0) + 1;
    return z >= min - 1;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  let onPortClick = null;

  function labelIcon(className, text) {
    text = escapeHtml(text);
    return L.divIcon({ className: `chart-label ${className}`, html: `<span>${text}</span>`, iconSize: [0, 0] });
  }

  function createLabelLayer(map) {
    const group = L.layerGroup();
    const MAX_LABELS = 350;

    function refresh() {
      if (!map.hasLayer(group)) return;
      group.clearLayers();
      const z = map.getZoom();
      const bounds = map.getBounds().pad(0.1);
      const placed = []; // screen positions of labels already shown, to avoid overlaps
      const add = (lat, lon, cls, text, port) => {
        if (placed.length >= MAX_LABELS || !bounds.contains([lat, lon])) return;
        const p = map.latLngToContainerPoint([lat, lon]);
        const halfWidth = text.length * 3.5 + 6;
        if (placed.some((q) => Math.abs(q.x - p.x) < halfWidth + q.halfWidth && Math.abs(q.y - p.y) < 16)) return;
        placed.push({ x: p.x, y: p.y, halfWidth });
        const m = L.marker([lat, lon], { icon: labelIcon(cls, text), interactive: !!port, keyboard: false }).addTo(group);
        if (port) m.on('click', () => onPortClick && onPortClick(port, m));
      };

      for (const f of labelData.marine) {
        if (!marineVisible(f.properties, z)) continue;
        const [lon, lat] = f.geometry.coordinates;
        const cls = f.properties.featurecla === 'ocean' ? 'ocean' : 'sea';
        add(lat, lon, cls, f.properties.name);
      }
      if (z >= 5) {
        for (const f of labelData.ports) {
          if (z < (f.properties.scalerank || 0) - 1) continue;
          const [lon, lat] = f.geometry.coordinates;
          add(lat, lon, 'port', `⚓ ${f.properties.name}`, { name: f.properties.name, lat, lon });
        }
      }
      if (z >= 4) {
        for (const f of labelData.places) {
          if (z < (f.properties.scalerank || 0)) continue;
          const [lon, lat] = f.geometry.coordinates;
          add(lat, lon, 'place', f.properties.name);
        }
      }
    }

    map.on('moveend zoomend overlayadd', refresh);
    group.refresh = refresh;
    return group;
  }

  // --- Depth lookup: deepest isobath polygon containing a point ---

  let depthPolys = []; // { depth, bbox: [w, s, e, n], rings }
  let landPolys = [];

  function ringContains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Flattens Polygon/MultiPolygon features into { depth, bbox, rings } entries.
  function indexPolygons(features) {
    const out = [];
    for (const f of features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const rings of polys) {
        let w = 180, s = 90, e = -180, n = -90;
        for (const [x, y] of rings[0]) {
          if (x < w) w = x;
          if (x > e) e = x;
          if (y < s) s = y;
          if (y > n) n = y;
        }
        out.push({ depth: f.properties && f.properties.depth, bbox: [w, s, e, n], rings });
      }
    }
    return out;
  }

  function polyContains(p, lat, lon) {
    const [w, s, e, n] = p.bbox;
    if (lon < w || lon > e || lat < s || lat > n) return false;
    if (!ringContains(p.rings[0], lon, lat)) return false;
    return !p.rings.slice(1).some((h) => ringContains(h, lon, lat));
  }

  // Returns { from, to } in metres (to = null below the deepest level), { land: true },
  // or null before the data has loaded.
  function depthAt(lat, lon) {
    if (!depthPolys.length) return null;
    if (landPolys.some((p) => polyContains(p, lat, lon))) return { land: true };
    for (const p of depthPolys) {
      if (!polyContains(p, lat, lon)) continue;
      const i = DEPTH_LEVELS.indexOf(p.depth);
      return { from: p.depth, to: DEPTH_LEVELS[i + 1] ?? null };
    }
    return { from: 0, to: DEPTH_LEVELS[1] };
  }

  function legend() {
    return DEPTH_LEVELS.map((d) => ({ depth: d, color: P.depth[d] }));
  }

  // Returns the layers right away; they fill in once `ready` resolves.
  function createWorldChart(map, loadLayer, opts = {}) {
    onPortClick = opts.onPortClick || null;
    const chart = new WorldChartLayer();
    const labels = createLabelLayer(map);

    const ready = (async () => {
      for (const layer of LAYERS) {
        const data = JSON.parse(await loadLayer(layer.name));
        if (layer.name === 'bathymetry') {
          depthPolys = indexPolygons(data.features).sort((a, b) => b.depth - a.depth);
        }
        if (layer.name === 'land') landPolys = indexPolygons(data.features);
        indexes[layer.name] = geojsonvt(data, {
          maxZoom: INDEX_MAX_ZOOM, extent: EXTENT, buffer: 64, tolerance: 2,
        });
      }
      labelData.marine = JSON.parse(await loadLayer('marine-labels')).features;
      labelData.ports = JSON.parse(await loadLayer('ports')).features;
      labelData.places = JSON.parse(await loadLayer('places')).features;
      chart.redraw();
      labels.refresh();
    })();

    function setGraticule(on) {
      showGraticule = on;
      chart.redraw();
    }

    function setTheme(name) {
      P = THEMES[name] || THEMES.night;
      chart.redraw();
    }

    return { chart, labels, ready, setTheme, setGraticule, depthAt, legend };
  }

  window.WorldChart = { createWorldChart, DEPTH_LEVELS };
})();
