#!/usr/bin/env node
// Builds the map data in public/data from Natural Earth (public domain).
//
//   npm run build:geodata
//
// Output:
//   public/data/world.json            simplified country outlines (for the map image + map backdrop)
//   public/data/countries.json        [{ code, name, bbox, provinces }] for the country picker
//   public/data/provinces/<CODE>.json simplified province polygons for one country
//
// The generated files are committed, so this only needs to be re-run to change resolution.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data');
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const SOURCES = {
  admin1: `${NE}/ne_10m_admin_1_states_provinces.geojson`,
  admin0: `${NE}/ne_50m_admin_0_countries.geojson`,
};

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

const round = (n) => Math.round(n * 1000) / 1000;

// mapshaper writes RFC 7946 (counter-clockwise) rings; d3-geo, used to render the
// Discord image, expects the opposite. Leaflet doesn't care either way.
function rewind(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) for (const ring of poly) ring.reverse();
  return geometry;
}

function eachPolygon(geometry, fn) {
  if (geometry.type === 'Polygon') fn(geometry.coordinates);
  else for (const poly of geometry.coordinates) fn(poly);
}

// Bounding box of a country's main land mass: the largest polygons that together make up
// 90% of its area, so remote specks (e.g. Norway's Bouvet Island) don't zoom the map out.
function mainBbox(features, wrap = false) {
  const parts = [];
  for (const f of features) {
    eachPolygon(f.geometry, (poly) => {
      const ring = poly[0];
      let area = 0;
      let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < ring.length; i++) {
        const lon = (x) => (wrap && x < 0 ? x + 360 : x);
        const [x, y] = [lon(ring[i][0]), ring[i][1]];
        const [x2, y2] = [lon(ring[(i + 1) % ring.length][0]), ring[(i + 1) % ring.length][1]];
        area += x * y2 - x2 * y;
        w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
      }
      parts.push({ area: Math.abs(area / 2), bbox: [w, s, e, n] });
    });
  }
  parts.sort((a, b) => b.area - a.area);
  const total = parts.reduce((sum, p) => sum + p.area, 0);
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  let acc = 0;
  for (const p of parts) {
    box[0] = Math.min(box[0], p.bbox[0]); box[1] = Math.min(box[1], p.bbox[1]);
    box[2] = Math.max(box[2], p.bbox[2]); box[3] = Math.max(box[3], p.bbox[3]);
    acc += p.area;
    if (acc >= total * 0.9) break;
  }
  // Crosses the antimeridian (e.g. Russia): measure again with longitudes in 0..360.
  if (!wrap && box[2] - box[0] > 300) return mainBbox(features, true);
  return box.map(round);
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), 'geodata-'));
  try {
    const admin1 = path.join(tmp, 'admin1.geojson');
    const admin0 = path.join(tmp, 'admin0.geojson');
    await download(SOURCES.admin1, admin1);
    await download(SOURCES.admin0, admin0);

    await rm(OUT, { recursive: true, force: true });
    await mkdir(path.join(OUT, 'provinces'), { recursive: true });

    console.log('Simplifying provinces…');
    const split = path.join(tmp, 'split');
    await mkdir(split);
    await mapshaper.runCommands(
      `-i "${admin1}" -filter-fields adm1_code,name,name_en,type_en,adm0_a3,admin,latitude,longitude ` +
        `-simplify 10% keep-shapes -clean -split adm0_a3 -o "${split}/" format=geojson precision=0.001`,
    );

    console.log('Simplifying countries…');
    await mapshaper.runCommands(
      `-i "${admin0}" -filter-fields ADM0_A3,NAME -rename-fields code=ADM0_A3,name=NAME ` +
        `-simplify 20% keep-shapes -clean -o "${path.join(OUT, 'world.json')}" format=geojson precision=0.01`,
    );

    const worldFile = path.join(OUT, 'world.json');
    const world = JSON.parse(await readFile(worldFile, 'utf8'));
    for (const f of world.features) rewind(f.geometry);
    await writeFile(worldFile, JSON.stringify(world));

    const countries = [];
    for (const file of await readdir(split)) {
      const fc = JSON.parse(await readFile(path.join(split, file), 'utf8'));
      const code = fc.features[0]?.properties.adm0_a3;
      if (!code) continue;
      const features = fc.features.map((f) => {
        const p = f.properties;
        return {
          type: 'Feature',
          properties: {
            id: p.adm1_code,
            name: p.name || p.name_en || p.adm1_code,
            type: p.type_en || null,
            // Natural Earth label point: always inside the province, unlike a centroid.
            lat: round(p.latitude),
            lon: round(p.longitude),
          },
          geometry: rewind(f.geometry),
        };
      });
      features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
      const collection = { type: 'FeatureCollection', features };
      await writeFile(path.join(OUT, 'provinces', `${code}.json`), JSON.stringify(collection));
      countries.push({
        code,
        name: fc.features[0].properties.admin,
        bbox: mainBbox(features),
        provinces: features.length,
      });
    }
    countries.sort((a, b) => a.name.localeCompare(b.name));
    await writeFile(path.join(OUT, 'countries.json'), JSON.stringify(countries));
    console.log(`Wrote ${countries.length} countries to ${OUT}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
