'use strict';

// AIS targets on the chart: a heading-oriented triangle per vessel, coloured by ship type, with a
// popup (name, type, speed, destination, range/bearing, CPA/TCPA). Targets closing within 1 nm in the
// next 30 minutes are flagged as dangerous.

(function () {
  const STALE_MS = 3 * 60e3;
  const REMOVE_MS = 10 * 60e3;
  const DANGER_CPA_NM = 1;
  const DANGER_TCPA_MIN = 30;

  const NAV_STATUS = ['Under way (engine)', 'At anchor', 'Not under command', 'Restricted manoeuvrability',
    'Constrained by draught', 'Moored', 'Aground', 'Fishing', 'Under way (sail)'];

  function typeGroup(t) {
    if (t == null) return 'other';
    if (t >= 70 && t <= 79) return 'cargo';
    if (t >= 80 && t <= 89) return 'tanker';
    if (t >= 60 && t <= 69) return 'passenger';
    if (t === 30) return 'fishing';
    if (t >= 36 && t <= 37) return 'pleasure';
    if ([31, 32, 52].includes(t)) return 'tug';
    if (t >= 50 && t <= 59) return 'special';
    if (t >= 40 && t <= 49) return 'hsc';
    return 'other';
  }
  const TYPE_NAMES = {
    cargo: 'Cargo', tanker: 'Tanker', passenger: 'Passenger', fishing: 'Fishing', pleasure: 'Sailing / pleasure',
    tug: 'Tug', special: 'Special craft', hsc: 'High-speed craft', other: 'Vessel',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  class AisLayer {
    // getOwn() -> { lat, lon, sog, cog } | null
    constructor(map, getOwn, onDanger) {
      this.map = map;
      this.getOwn = getOwn;
      this.onDanger = onDanger;
      this.group = L.layerGroup();
      this.targets = new Map();
      this.warned = new Set();
      setInterval(() => this.prune(), 30e3);
    }

    update(msg) {
      if (msg.own) return;
      const t = this.targets.get(msg.mmsi) || { mmsi: msg.mmsi };
      for (const [k, v] of Object.entries(msg)) if (v != null && v !== '') t[k] = v;
      t.seen = Date.now();
      this.targets.set(msg.mmsi, t);
      if (t.lat != null) this.draw(t);
    }

    icon(t, danger) {
      const rot = t.heading ?? t.cog ?? 0;
      const moving = (t.sog || 0) > 0.5;
      const cls = `ais-target ${typeGroup(t.shipType)} ${danger ? 'danger' : ''} ${Date.now() - t.seen > STALE_MS ? 'stale' : ''}`;
      const label = this.map.getZoom() >= 9 && t.name ? `<span class="ais-name">${esc(t.name)}</span>` : '';
      const shape = moving
        ? '<path d="M0,-10 L6,8 L0,4 L-6,8 Z"/>'
        : '<circle r="4.5"/>';
      // Speed vector: where the target will be in 6 minutes, scaled for the screen.
      const vec = moving ? `<line x1="0" y1="-10" x2="0" y2="${-10 - Math.min(40, t.sog * 2.5)}"/>` : '';
      return L.divIcon({
        className: cls,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        html: `<svg width="24" height="24" viewBox="-12 -12 24 24" style="transform:rotate(${rot}deg)">${vec}${shape}</svg>${label}`,
      });
    }

    danger(t) {
      const own = this.getOwn();
      if (!own || t.lat == null) return null;
      const r = NavCore.cpa(own, t);
      const isDanger = r.cpaNm < DANGER_CPA_NM && r.tcpaMin > 0 && r.tcpaMin < DANGER_TCPA_MIN;
      return { ...r, isDanger };
    }

    draw(t) {
      const d = this.danger(t);
      const isDanger = !!(d && d.isDanger);
      if (!t.marker) {
        t.marker = L.marker([t.lat, t.lon], { icon: this.icon(t, isDanger), keyboard: false, zIndexOffset: 400 });
        t.marker.bindPopup(() => this.popup(t), { className: 'ais-popup', maxWidth: 280 });
        t.marker.addTo(this.group);
      } else {
        t.marker.setLatLng([t.lat, t.lon]);
        t.marker.setIcon(this.icon(t, isDanger));
        if (t.marker.isPopupOpen()) t.marker.setPopupContent(this.popup(t));
      }
      t.isDanger = isDanger;
      if (isDanger && !this.warned.has(t.mmsi)) {
        this.warned.add(t.mmsi);
        this.onDanger && this.onDanger(t, d);
      }
      if (!isDanger) this.warned.delete(t.mmsi);
    }

    popup(t) {
      const d = this.danger(t);
      const row = (k, v) => (v == null || v === '' ? '' : `<tr><td>${k}</td><td>${v}</td></tr>`);
      return `
        <div class="ais-title">${esc(t.name || `MMSI ${t.mmsi}`)}</div>
        <div class="ais-sub">${TYPE_NAMES[typeGroup(t.shipType)]} · class ${t.class || '?'}${t.callsign ? ` · ${esc(t.callsign)}` : ''}</div>
        <table>
          ${row('MMSI', t.mmsi)}
          ${row('Status', t.navStatus != null ? NAV_STATUS[t.navStatus] : null)}
          ${row('SOG / COG', `${t.sog != null ? t.sog.toFixed(1) + ' kn' : '—'} / ${t.cog != null ? Math.round(t.cog) + '°' : '—'}`)}
          ${row('Heading', t.heading != null ? `${t.heading}°` : null)}
          ${row('Destination', esc(t.destination))}
          ${row('Length', t.length ? `${t.length} m` : null)}
          ${d ? row('Range / bearing', `${d.rangeNm.toFixed(1)} nm / ${String(Math.round(d.bearing)).padStart(3, '0')}°`) : ''}
          ${d && d.tcpaMin > 0 ? row('CPA / TCPA', `<b class="${d.isDanger ? 'danger' : ''}">${d.cpaNm.toFixed(2)} nm in ${Math.round(d.tcpaMin)} min</b>`) : ''}
          ${row('Last seen', `${Math.round((Date.now() - t.seen) / 1000)} s ago`)}
        </table>`;
    }

    prune() {
      const now = Date.now();
      for (const [mmsi, t] of this.targets) {
        if (now - t.seen > REMOVE_MS) {
          if (t.marker) this.group.removeLayer(t.marker);
          this.targets.delete(mmsi);
        } else if (t.lat != null) {
          this.draw(t);
        }
      }
    }

    // Re-evaluate CPA against the latest own position.
    refresh() {
      for (const t of this.targets.values()) if (t.lat != null) this.draw(t);
    }

    stats() {
      let total = 0, danger = 0;
      for (const t of this.targets.values()) {
        if (t.lat == null) continue;
        total++;
        if (t.isDanger) danger++;
      }
      return { total, danger };
    }
  }

  window.AisLayer = AisLayer;
})();
