'use strict';

// Offline world nautical chart: Natural Earth 1:10m vectors, sliced with geojson-vt
// and drawn on canvas tiles in a paper-chart style.

(function () {
  const EXTENT = 4096;
  const INDEX_MAX_ZOOM = 14; // deeper zooms reuse z14 geometry, scaled up

  const DEPTH_COLORS = {
    0: '#d4ecf7', 200: '#bfe0f2', 1000: '#a8d3ec', 2000: '#93c5e5', 3000: '#7fb7dd',
    4000: '#6ca9d4', 5000: '#5b9bca', 6000: '#4c8dbf', 7000: '#4080b4',
    8000: '#3573a8', 9000: '#2b679c', 10000: '#225b90',
  };

  const STYLE = {
    ocean: '#225b90',
    land: '#f3e9cf',
    ice: '#fbfdff',
    lake: '#bfe0f2',
    river: '#8cbde0',
    coast: '#6b5a3e',
    border: '#a07ea0',
    reef: '#c0504d',
    graticule: 'rgba(60, 80, 110, 0.35)',
  };

  // Draw order; each entry is filled/stroked with its own style.
  const LAYERS = [
    { name: 'bathymetry', fill: (p) => DEPTH_COLORS[p.depth] || STYLE.ocean },
    { name: 'land', fill: () => STYLE.land },
    { name: 'ice', fill: () => STYLE.ice },
    { name: 'lakes', fill: () => STYLE.lake, minZoom: (p) => (p.scalerank || 0) - 2 },
    { name: 'rivers', stroke: () => STYLE.river, width: 1, minZoom: (p) => (p.scalerank || 0) - 4 },
    { name: 'reefs', stroke: () => STYLE.reef, width: 1.2, dash: [2, 3], minZoom: () => 6 },
    { name: 'borders', stroke: () => STYLE.border, width: 1, dash: [6, 3] },
    { name: 'coastline', stroke: () => STYLE.coast, width: 0.8 },
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
      ctx.fillStyle = STYLE.ocean;
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
        for (const f of t.features) {
          if (layer.minZoom && coords.z < layer.minZoom(f.tags)) continue;
          drawGeometry(ctx, f, scale, dx, dy);
          if (layer.fill) {
            ctx.fillStyle = layer.fill(f.tags);
            ctx.fill('evenodd');
          } else {
            ctx.strokeStyle = layer.stroke(f.tags);
            ctx.lineWidth = layer.width;
            ctx.setLineDash(layer.dash || []);
            ctx.stroke();
          }
        }
      }
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
      ctx.strokeStyle = STYLE.graticule;
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

  function labelIcon(className, text) {
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

    return { chart, labels, ready };
  }

  window.WorldChart = { createWorldChart };
})();
