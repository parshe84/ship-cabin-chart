'use strict';

// Builds the bundled offline world chart from Natural Earth 1:10m data (public domain).
// Usage: npm run build-map   (downloads ~110 MB into .cache/, writes src/maps/world/*.json)

const fs = require('fs');
const path = require('path');
const mapshaper = require('mapshaper');

const SOURCE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const cacheDir = path.join(__dirname, '..', '.cache', 'naturalearth');
const outDir = path.join(__dirname, '..', 'src', 'maps', 'world');

const BATHYMETRY = [
  ['L_0', 0], ['K_200', 200], ['J_1000', 1000], ['I_2000', 2000], ['H_3000', 3000],
  ['G_4000', 4000], ['F_5000', 5000], ['E_6000', 6000], ['D_7000', 7000],
  ['C_8000', 8000], ['B_9000', 9000], ['A_10000', 10000],
];

async function download(name) {
  const file = path.join(cacheDir, `${name}.geojson`);
  if (fs.existsSync(file)) return file;
  process.stdout.write(`download ${name}… `);
  const res = await fetch(`${SOURCE}/${name}.geojson`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log('ok');
  return file;
}

// Runs mapshaper on the given inputs and returns the resulting GeoJSON object.
async function shape(inputs, commands) {
  const files = await Promise.all(inputs.map(download));
  const cmd = `-i ${files.map((f) => JSON.stringify(f)).join(' ')} combine-files -merge-layers force ` +
    `${commands} -o out.json format=geojson geojson-type=FeatureCollection precision=0.001`;
  const output = await mapshaper.applyCommands(cmd);
  return JSON.parse(output['out.json']);
}

function write(name, geojson) {
  const file = path.join(outDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(geojson));
  console.log(`${name}.json  ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${geojson.features.length} features`);
}

async function main() {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const SIMPLIFY = '-simplify 25% keep-shapes';

  // Depth bands: every layer is "sea deeper than N metres"; drawn shallow to deep.
  const bathymetry = { type: 'FeatureCollection', features: [] };
  for (const [suffix, depth] of BATHYMETRY) {
    const layer = await shape([`ne_10m_bathymetry_${suffix}`], `${SIMPLIFY} -filter-fields -each "depth=${depth}"`);
    bathymetry.features.push(...layer.features);
  }
  write('bathymetry', bathymetry);

  write('land', await shape(['ne_10m_land', 'ne_10m_minor_islands'], `${SIMPLIFY} -filter-fields`));
  write('coastline', await shape(['ne_10m_coastline'], `${SIMPLIFY} -filter-fields`));
  write('ice', await shape(['ne_10m_antarctic_ice_shelves_polys', 'ne_10m_glaciated_areas'], `${SIMPLIFY} -filter-fields`));
  write('lakes', await shape(['ne_10m_lakes'], `${SIMPLIFY} -filter-fields scalerank`));
  write('rivers', await shape(['ne_10m_rivers_lake_centerlines'], `${SIMPLIFY} -filter-fields scalerank`));
  write('borders', await shape(['ne_10m_admin_0_boundary_lines_land'], `${SIMPLIFY} -filter-fields`));
  write('reefs', await shape(['ne_10m_reefs'], `${SIMPLIFY} -filter-fields`));

  // Oceans, seas, bays, straits: one label point per area.
  write('marine-labels', await shape(['ne_10m_geography_marine_polys'],
    '-points inner -filter-fields name,featurecla,scalerank,min_label'));
  write('ports', await shape(['ne_10m_ports'], '-filter-fields name,scalerank'));
  write('places', await shape(['ne_10m_populated_places_simple'],
    '-filter "scalerank <= 7" -filter-fields name,scalerank'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
