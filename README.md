# Ship Cabin Chart

See your ship's position on a world nautical chart from your cabin. An Android phone on the
porthole picks up GPS, and a laptop in the cabin shows the ship on the chart.

```
 [Android phone on the porthole]  ── Wi-Fi, UDP :10110, NMEA 0183 ──▶  [Laptop: Ship Cabin Chart]
   android-gps-sender                                                   desktop-chart (Electron)
```

## Components

| Folder | What it is |
|---|---|
| `android-gps-sender/` | **Cabin GPS** Android app. Reads the phone's GPS and broadcasts NMEA sentences (`RMC`, `GGA`, `VTG`) over UDP. Keeps running in the background with the screen off. |
| `desktop-chart/` | Portable Electron app. Shows a built-in offline world chart, the ship with its heading, the track, speed in knots and coordinates in degrees/minutes. |

## Design

Two looks, switched with the **Day / Night / Auto** button:

- **Night: "Neon Abyss".** A near-black ocean with glowing cyan coastlines and isobaths, a hot-pink ship
  with a sonar pulse and a glowing track. Easy on the eyes in a dark cabin.
- **Day: "Coastal Glass".** A turquoise-to-cobalt depth gradient, light land and frosted-glass panels.
- **Auto** switches by the **sun's elevation at the ship's position** (night below −6°, civil twilight),
  not by the laptop clock, so it stays right across time zones.

The HUD shows a compass dial with the course needle, speed over ground, distance logged, satellites and
position. **GPX** exports the track for OpenCPN, Navionics, Google Earth and similar apps.

## Maps

**Built-in world chart, works fully offline.**

**Depths: a general bathymetric chart of the whole World Ocean.** Isobaths at standard chart depths
**10, 20, 50, 100, 200, 500, 1,000, 2,000 … 10,000 m**, traced from [ETOPO1](https://www.ncei.noaa.gov/products/etopo-global-relief-model)
(NOAA, 1 arc-minute global relief, public domain) via the [Mapzen Terrarium](https://registry.opendata.aws/terrain-tiles/)
tiles on AWS Open Data. The HUD shows the **chart depth under the ship**, and the legend shows the depth
**under the cursor**. Resolution is about 2 km: this is a general chart for overview, not for navigation in
shallow water.

Everything else comes from [Natural Earth](https://www.naturalearthdata.com/) 1:10m data (public domain):

- land, coastlines, islands, glaciers and ice shelves
- lakes, rivers, reefs and country borders
- names of 306 oceans, seas, bays and straits
- 1,081 seaports and major cities
- latitude/longitude grid that gets finer as you zoom in

It covers the whole planet and is sharpest at ocean and regional scale (roughly zoom 1–9).

**Detailed coastal maps (zoom 9+).** OpenStreetMap and OpenSeaMap seamarks are drawn on top whenever
they are available, either online or from the local cache. Before a voyage, open the area in port and use
**Download detailed area**. Every tile you have looked at is cached too. Each download is limited to
3,000 tiles, as required by the free OSM tile servers' usage policy.

To rebuild the chart: `npm run build-map` (Natural Earth layers) and
`python3 scripts/build-bathymetry.py` (depths; needs `pip install numpy pillow contourpy shapely`).

## How to use

1. Connect the phone and the laptop to the same Wi-Fi network. Without ship Wi-Fi, turn on the phone's hotspot and connect the laptop to it.
2. On the laptop, run **ShipCabinChart-portable.exe**. Nothing to install: data is stored in `ShipCabinChart-data` next to the exe.
3. On the phone, open **Cabin GPS** and tap **Start sending**. The default address `255.255.255.255` broadcasts to the whole network. If that doesn't work, enter the laptop's IP, which is shown in the desktop app's **Settings**.
4. On first launch Windows asks about the firewall. Allow access for private networks.

### Third-party GPS apps

Any app that outputs NMEA works too:
- UDP to port 10110: nothing to configure;
- TCP (for example "Share GPS" or "GPS2IP"): enter the phone's IP and port in **Settings**.

## Building

GitHub Actions builds the APK, a Windows portable `.exe` and a Linux AppImage on every push.
When the version in `desktop-chart/package.json` changes, CI also publishes them as a **GitHub Release**. Download them from the
repository's **Releases** page.

Locally:

```bash
# Desktop
cd desktop-chart
npm install
npm start            # run
npm test             # NMEA parser tests
npm run dist:win     # portable .exe

# Android (requires Android SDK)
cd android-gps-sender
./gradlew assembleRelease   # app/build/outputs/apk/release/
```

> ⚠️ This is an aid only. It does not replace the ship's official navigation equipment or charts.
