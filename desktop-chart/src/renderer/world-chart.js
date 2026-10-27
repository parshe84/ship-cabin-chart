'use strict';

// Offline world nautical chart: Natural Earth 1:10m vectors, sliced with geojson-vt
// and drawn on canvas tiles. Two looks: neon night and bright day.

(function () {
  const EXTENT = 4096;
  const INDEX_MAX_ZOOM = 14; // deeper zooms reuse z14 geometry, scaled up

  const THEMES = {
    night: {
      depth: {
        0: '#0a2a40', 200: '#082236', 1000: '#071d2f', 2000: '#061928', 3000: '#051622',
        4000: '#04131e', 5000: '#04111a', 6000: '#030f17', 7000: '#030d14',
        8000: '#020b11', 9000: '#02090e', 10000: '#01070b',
      },
      contour: 'rgba(0, 229, 255, 0.16)',
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
      graticule: 'rgba(0, 229, 255, 0.07)',
    },
    day: {
      depth: {
        0: '#c9f1f4', 200: '#a6e4ee', 1000: '#7fcfe6', 2000: '#5db8dc', 3000: '#45a2d2',
        4000: '#348bc6', 5000: '#2a76b8', 6000: '#2263a8', 7000: '#1c5298',
        8000: '#174488', 9000: '#133878', 10000: '#0f2d68',
      },
      contour: 'rgba(255, 255, 255, 0.35)',
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
      graticule: 'rgba(15, 45, 104, 0.12)',
    },
  };
  let P = THEMES.night;

  // Draw order; each entry is filled/stroked with the current palette.
  const LAYERS = [
    {
      name: 'bathymetry',
      fill: (p) => P.depth[p.depth] || P.ocean,
      outline: (p) => (p.depth > 0 ? P.contour : null), // isobaths as thin contour lines
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
    options: { tileSize: 256, maxZoom: 18, attribution: 'Natural Earth' },

    createTile(coords) {
      const size = this.getTileSize();
      const tile = document.createElement('canvas');
      const ratio = window.devicePixelRatio || 1;
      tile.width = size.x * ratio;
      tile.height = size.y * ratio;
      const ctx = tile.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.fillStyle = P.ocean;
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
            const outline = layer.outline && layer.outline(f.tags);
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
      this._drawGraticule(ctx, coords, size);
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
      const add = (lat, lon, cls, text) => {
        if (placed.length >= MAX_LABELS || !bounds.contains([lat, lon])) return;
        const p = map.latLngToContainerPoint([lat, lon]);
        const halfWidth = text.length * 3.5 + 6;
        if (placed.some((q) => Math.abs(q.x - p.x) < halfWidth + q.halfWidth && Math.abs(q.y - p.y) < 16)) return;
        placed.push({ x: p.x, y: p.y, halfWidth });
        L.marker([lat, lon], { icon: labelIcon(cls, text), interactive: false, keyboard: false }).addTo(group);
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
          add(lat, lon, 'port', `⚓ ${f.properties.name}`);
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

  // Returns the layers right away; they fill in once `ready` resolves.
  function createWorldChart(map, loadLayer) {
    const chart = new WorldChartLayer();
    const labels = createLabelLayer(map);

    const ready = (async () => {
      for (const layer of LAYERS) {
        const data = JSON.parse(await loadLayer(layer.name));
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

    function setTheme(name) {
      P = THEMES[name] || THEMES.night;
      chart.redraw();
    }

    return { chart, labels, ready, setTheme };
  }

  window.WorldChart = { createWorldChart };
})();
