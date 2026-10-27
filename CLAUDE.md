# Ship Cabin Chart

An Android phone on the porthole sends GPS to a laptop in the cabin, which shows the ship on a world nautical chart.
The UI is in English.

## Layout
- `android-gps-sender/`: Kotlin app "Cabin GPS". `GpsSenderService` (foreground, location) builds NMEA
  RMC/GGA/VTG with `NmeaBuilder` and sends it over UDP (default 255.255.255.255:10110). Unit tests are in `app/src/test`.
- `desktop-chart/`: portable Electron app.
  - `src/main.js`: UDP/TCP NMEA input, `tilecache://` protocol (OSM/OpenSeaMap disk cache + area download), GPX export, settings and track stored in `ShipCabinChart-data` next to the exe.
  - `src/nmea.js` + `test/nmea.test.js`: parser (`npm test`).
  - `src/renderer/world-chart.js`: offline world chart. Natural Earth 1:10m vectors in `src/maps/world/*.json`, sliced with geojson-vt, drawn on canvas; palettes for the `night` and `day` themes.
  - `src/renderer/app.js`: HUD, themes (auto by sun elevation, see `sun.js`), track, labels.
  - `src/renderer/nav-core.js`: navigation maths shared with tests: rhumb legs, `SeaRouter` (Dijkstra over MARNET), `routeProgress` (DTG/XTE/waypoint switching), `SpeedAverage`.
  - `src/renderer/voyage.js`: `RoutePlanner` (route from GPS position, Shift+click sea lanes), `MeasureTool`, `GridLabels`, ports/distance dialog.
  - `src/s57/` (+ `test/s57.test.js`, `test/s57-writer.js` builds test cells): S-57 ENC reader. `iso8211.js` parses the
    container, `s57.js` resolves topology, applies updates and outputs GeoJSON; `catalogue.json` from `scripts/build-s57-catalogue.py`.
  - `src/enc-library.js`: ENC import (files/folders/zip via fflate) into `ShipCabinChart-data/enc`, converted in
    `enc-worker.js` (asar-unpacked). `renderer/enc-layer.js` draws cells with S-52-like symbology and answers pick/depth queries.
  - `src/rtz.js` (+ `test/rtz.test.js`): ECDIS route exchange, RTZ (IEC 61174) import/export and GPX route import.
  - `src/ais.js` (+ `test/ais.test.js`): AIS decoder for types 1/2/3/5/18/19/24; `renderer/ais-layer.js` draws targets with CPA/TCPA.
  - `renderer/barometer.js`: pressure history (`pressure.json`), trend, storm alert; `sun.js` also has sunrise/sunset, moon phase, zone time.
  - Phone sentences: `$IIXDR,P,<bar>,B,Barometer` and `$HCHDT,<deg>,T`; QR pairing URL `cabingps://connect?host=<ip>&port=<port>`.
  - `scripts/build-sea-routes.py`: builds `sea-routes.json` (network + ~4,000 ports) and `distance-table.json` from searoute-py data.
  - `scripts/build-osm-maritime.py`: builds `maritime.json` (TSS + territorial/contiguous/EEZ/baseline lines, ODbL) from the OSM planet ORC on S3; drawn by `drawMaritime` in `world-chart.js`.
  - `scripts/build-osm-land.py`: builds `src/maps/land/*.bin` (OSM land polygons, 5° squares, varint-delta binary) from
    Daylight earth `theme=land`; `world-chart.js` draws them instead of Natural Earth land from zoom 8 (`COAST_MIN_ZOOM`).
  - `scripts/build-osm-seamarks.py`: builds `src/maps/seamarks/*.json` (OpenSeaMap nodes mapped to S-57 classes, 10° squares)
    from the planet ORC; `enc-layer.js` loads them as built-in "cells" (band 0, per-object min zoom).
  - `scripts/build-world-map.js`: rebuilds the Natural Earth layers in `src/maps/world` (`npm run build-map`).
  - `scripts/build-bathymetry.py`: rebuilds `src/maps/world/bathymetry.json` (isobaths 10…10000 m) from ETOPO1 via Terrarium tiles on S3. `world-chart.js` `DEPTH_LEVELS` must match its `DEPTHS`.
- Fonts (Space Grotesk, JetBrains Mono) are bundled from `@fontsource-variable` because the app must work offline.

## Building and checking
- `cd desktop-chart && npm ci && npm test && npm start`
- The Android SDK isn't available in cloud sessions, so CI (`.github/workflows/build.yml`) compiles and tests Android.
- Bumping `version` in `desktop-chart/package.json` and pushing to main publishes GitHub Release `v<version>` with the APK and the Windows portable exe (cloud sessions can't push tags). There is no Linux build.
