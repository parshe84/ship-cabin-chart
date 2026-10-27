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

## Maps

**Built-in world chart, works fully offline.** Made from [Natural Earth](https://www.naturalearthdata.com/)
1:10m data (public domain):

- ocean depth bands (bathymetry) from 0 to 10,000 m
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

To rebuild the world chart from the latest Natural Earth release, run `npm run build-map`.

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
Download them from the **Actions** tab, under *Artifacts* of the run.

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
