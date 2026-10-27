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
  - `scripts/build-world-map.js`: rebuilds `src/maps/world` from Natural Earth (`npm run build-map`).
- Fonts (Space Grotesk, JetBrains Mono) are bundled from `@fontsource-variable` because the app must work offline.

## Building and checking
- `cd desktop-chart && npm ci && npm test && npm start`
- The Android SDK isn't available in cloud sessions, so CI (`.github/workflows/build.yml`) compiles and tests Android.
- Bumping `version` in `desktop-chart/package.json` and pushing to main publishes GitHub Release `v<version>` with the APK, the Windows portable exe and the Linux AppImage (cloud sessions can't push tags).
