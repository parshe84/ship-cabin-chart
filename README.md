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

## Phone sensors and pairing

- **QR pairing.** *Setup* on the laptop shows a QR code; **Scan QR code** in Cabin GPS fills in the address
  and starts sending. No typing IP addresses, and the position goes only to this laptop instead of being
  broadcast to the whole network.
- **Barometer.** If the phone has a pressure sensor, the HUD shows pressure, the 1 h / 3 h trend and a
  barograph. A fall of **3 hPa in 3 hours** raises a gale warning (sound + banner), 6 hPa a storm warning.
  A ship weather station sending NMEA `XDR`/`MDA` works too.
- **Compass heading.** The phone's compass is sent as `HDT` (true, corrected for magnetic declination). The phone
  rarely points at the bow, so the mounting offset is **learnt automatically** from the GPS course while
  under way (> 4 kn, steady course). When the ship is stopped, the chart turns the ship by the heading.

## Safety and display

- **AIS.** If the ship's AIS feed (`!AIVDM`) reaches the laptop over UDP/TCP, nearby vessels are shown with name,
  type, speed vector and **CPA/TCPA**. A target passing closer than 1 nm within 30 minutes raises an alarm.
- **Red night mode.** Dim red on black keeps your night vision (Day / Night / Red / Auto button).
- **Sun, moon and ship time.** Sunrise and sunset at the ship's position, moon phase, and ship time by
  nautical zone (ZD from longitude).
- **Ports on the chart.** Click a port to see the sea distance and ETA from the ship and route there in one click.
- **Cabin display.** The monitor button shows big numbers full-screen: speed, course, position, ship time,
  distance to go and ETA, depth, pressure. Good for a TV in the cabin.
- **Maps along the route.** *Maps → Along the planned route* downloads detailed tiles in a corridor of ±N nm
  along the whole route, with a tile estimate before you start.
- **Updates.** The app checks GitHub Releases and can download the new portable exe next to the current one
  and restart into it. This works when the repository's releases are public.

## Voyage tools

- **Route from the ship (Route).** The route starts at the current GPS position (without a GPS fix the first
  click places the start). **Click** adds a waypoint;
  **Shift+click** routes along the shipping lanes around land (through Suez, Panama, Gibraltar and other
  straits), with a live preview while Shift is held. A tooltip at the cursor shows the leg course and distance,
  the total and the **ETA**. Drag the start and any waypoint with the left mouse button (also after planning),
  click the line to insert one, right-click to delete, **Enter**/double-click to finish. The route is saved and
  can be exported as GPX or **RTZ** for ECDIS.
- **ECDIS routes (RTZ).** *Route → Import RTZ* (or **Ctrl+O**) opens an IEC 61174 `.rtz` route exported from an
  ECDIS (RTZ 1.0–1.2, UTF-8 or UTF-16) or a GPX route. The **RTZ** button in the voyage bar exports the route
  as RTZ 1.0 with rhumb-line legs.
- **Right-click on the chart** shows the position (degrees and decimal minutes, and decimal), the chart depth
  and the bearing/distance from the ship, with *Copy*, *Route here / Add waypoint* and *Measure from here*.
- **Map download** skips open-ocean tiles by default (*Coasts only*) and suggests the highest zoom that fits
  the tile limit.
- **Voyage bar.** While following the route: next waypoint (bearing and distance), **XTE** (cross-track error,
  S = starboard, P = port), **distance to go** and **ETA** (UTC) with time to go. Waypoints switch automatically
  when reached or passed. ETA uses the **average SOG over the last 10 minutes** or a planned speed you set.
- **Measure.** A quick ruler between any points: rhumb-line course and distance per leg, total in nm and km.
- **Lat/lon grid.** Grid lines with degree and minute labels along the chart edges, finer as you zoom in
  (toggle in the layers menu).
- **World sea distances (Ports).** The shortest sea distance between any two of ~4,000 ports, or from the ship
  to a port, with passages to avoid (Suez, Panama, Malacca…). Includes a distance table for 47 major world ports.
  Use any result as your route. The network is Eurostat SeaRoute / MARNET (via searoute-py, Apache-2.0). Its
  distances agree with published port-distance tables within a few percent (Rotterdam–Singapore 8,386 nm,
  Shanghai–Los Angeles 5,776 nm, Singapore–Hong Kong 1,457 nm). Rebuild it with
  `python3 scripts/build-sea-routes.py`.

## Maps

**Built-in world chart, works fully offline.**

**Depths: a general bathymetric chart of the whole World Ocean.** Isobaths at standard chart depths
**10, 20, 50, 100, 200, 500, 1,000, 2,000 … 10,000 m**, traced from [ETOPO1](https://www.ncei.noaa.gov/products/etopo-global-relief-model)
(NOAA, 1 arc-minute global relief, public domain) via the [Mapzen Terrarium](https://registry.opendata.aws/terrain-tiles/)
tiles on AWS Open Data. The HUD shows the **chart depth under the ship**, and the legend shows the depth
**under the cursor**. Resolution is about 2 km: this is a general chart for overview, not for navigation in
shallow water.

**Detailed depths from zoom 8: GEBCO 2026.** On continental shelves, coasts and banks (1,050 squares of 5°,
~21 MB) the depths come from the [GEBCO 2026 Grid](https://www.gebco.net/) (15 arc-seconds, about 460 m;
GEBCO Compilation Group (2026) GEBCO 2026 Grid, public domain), with isobaths at **5, 10, 20, 30, 50, 100,
200 m** and deeper. The depth under the cursor and under the ship uses them too. Near the coast GEBCO is
partly interpolated, so it shows the shape of the sea floor, not chart soundings: GEBCO itself must not be
used for navigation. Rebuilt with `python3 scripts/build-gebco.py` from the GEBCO GeoTIFF tiles.

**Traffic separation schemes and maritime limits** (layers menu), from [OpenStreetMap](https://www.openstreetmap.org/copyright)
(© OpenStreetMap contributors, data under the [ODbL 1.0](https://opendatacommons.org/licenses/odbl/)):

- IMO traffic separation schemes worldwide in chart magenta: separation zones, lines and boundaries,
  traffic lanes with direction arrows, roundabouts, inshore traffic zones and precautionary areas (zoom 7+);
- maritime limits: territorial sea (12 nm), contiguous zone (24 nm), EEZ and baselines, as mapped in OSM.

The file `src/maps/world/maritime.json` is a derived database of OpenStreetMap and is available under the ODbL.
It is rebuilt with `python3 scripts/build-osm-maritime.py`, which reads the planet straight from AWS Open Data
(`s3://osm-pds`). Coverage depends on OSM mapping, so these layers are for orientation and do not replace
official charts and Notices to Mariners.

Everything else comes from [Natural Earth](https://www.naturalearthdata.com/) 1:10m data (public domain):

- land, coastlines, islands, glaciers and ice shelves
- lakes, rivers, reefs and country borders
- names of 306 oceans, seas, bays and straits
- 1,081 seaports and major cities
- latitude/longitude grid that gets finer as you zoom in

It covers the whole planet and is sharpest at ocean and regional scale (roughly zoom 1–9).

**Detailed coastline from zoom 8, offline.** From zoom 8 the land is drawn from the OpenStreetMap land
polygons (built from `natural=coastline`), simplified to about 20 m: harbours, breakwaters, fjords, reclaimed
land such as Maasvlakte 2 and small islands, for the whole world (`src/maps/land`, 1,480 squares of 5°, ~42 MB).
Rebuilt with `python3 scripts/build-osm-land.py` from the Daylight Map Distribution on AWS Open Data.

**Seamarks worldwide, offline.** Lights (flare, sectors and characteristic such as `Fl(2) W 15s 20m 15M`, major
lights from zoom 6), buoys and beacons by shape and colour, wrecks, rocks, obstructions, harbours, marinas,
anchorages, pilot boarding places, landmarks and more, from the OpenSeaMap tags in OpenStreetMap
(about 485,000 objects incl. 100,000 lights and 150,000 buoys and beacons; `src/maps/seamarks`, ~28 MB, loaded per 10° square). Click a symbol for its details. They are drawn with the same
S-52-style symbols as ENC charts and can be switched off in the layers menu. Rebuilt with
`python3 scripts/build-osm-seamarks.py` (scans the planet file on AWS). The online OpenSeaMap overlay is
still in the layers menu but off by default.

Both are © OpenStreetMap contributors and available under the ODbL. They are as good as the OSM mapping in
each area: very detailed in Europe and busy ports, sparser elsewhere.

**Official ENC charts (S-57).** The **ENC** button imports electronic navigational charts from
hydrographic offices in the unencrypted IHO S-57 format: single cells (`.000` with their `.001…` updates,
which are applied in order), a whole folder such as an `ENC_ROOT` exchange set, or a `.zip` as downloaded.
Free sources include [NOAA](https://charts.noaa.gov/ENCs/ENCs.shtml) for all US waters. Encrypted S-63 cells
(C-MAP, Primar, AVCS) cannot be opened. Cells are converted once and kept in `ShipCabinChart-data/enc`.

They are drawn in a simplified IHO S-52 presentation, in the day, night and red themes:

- depth areas shaded by the **shallow, safety and deep contours** you set, the safety contour drawn bold;
- soundings (shallower than the safety contour in a darker colour), rocks, wrecks and obstructions, with the
  magenta **isolated danger** symbol for dangers shallower than the safety contour in deeper water;
- buoys and beacons by shape and colour (cardinal topmarks), lights with flares, **sectors** and their
  characteristic (e.g. `Fl(2) G 6s 12m 5M`), fog signals;
- traffic separation schemes, fairways, restricted, anchorage and cable areas, cables and pipelines, names.

Detail follows the cell's navigational purpose (overview to berthing) and each object's SCAMIN. **Click** a
buoy, light or line for its full S-57 attributes; **right-click** anywhere for the depth area and *Chart objects*.
The chart depth under the cursor and under the ship comes from the ENC where one covers it. The S-57 object
catalogue (`src/s57/catalogue.json`) is built from GDAL's tables (MIT) with `scripts/build-s57-catalogue.py`.
This is a planning and situational-awareness display, not a type-approved ECDIS.

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

GitHub Actions builds the APK and the Windows portable `.exe` on every push.
When the version in `desktop-chart/package.json` changes, CI also publishes them as a **GitHub Release**.
If the repository secrets `WIN_CSC_LINK` (base64 `.pfx`) and `WIN_CSC_KEY_PASSWORD` are set, the exe is
code-signed and Windows SmartScreen stops warning about an unknown publisher. Download them from the
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
