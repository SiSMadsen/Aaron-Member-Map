// Renders the member map as a PNG: every member is a dot in the province they picked.
import { Resvg } from '@resvg/resvg-js';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { getProvinces, world } from './geodata.js';

const WIDTH = 1600;
const HEIGHT = 900;
const PADDING = 40;
const DOT_RADIUS = 7;

const COLORS = {
  background: '#1b1e24',
  ocean: '#232831',
  land: '#3a404b',
  countryBorder: '#5b6270',
  provinceBorder: '#4b515d',
  dot: '#5865f2',
  dotStroke: '#ffffff',
};

const landFeatures = world.features.filter((f) => f.properties.code !== 'ATA');

/**
 * Longitude/latitude box around the points, padded and with a minimum size so a single
 * member doesn't zoom all the way in. Returns null when the whole world should be shown.
 */
function viewBox(points) {
  if (points.length === 0) return null;
  const lats = points.map((p) => p[1]);
  // Pick the longitude range that doesn't cross the antimeridian unless that is shorter.
  const ranges = [(x) => x, (x) => (x < 0 ? x + 360 : x)].map((wrap) => {
    const lons = points.map((p) => wrap(p[0]));
    return [Math.min(...lons), Math.max(...lons)];
  });
  const [west, east] = ranges.reduce((a, b) => (b[1] - b[0] < a[1] - a[0] ? b : a));
  const south = Math.min(...lats);
  const north = Math.max(...lats);

  const lonSpan = Math.max((east - west) * 1.3, 40);
  const latSpan = Math.max((north - south) * 1.3, 22);
  if (lonSpan > 250) return null;
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  return {
    centerLon,
    west: centerLon - lonSpan / 2,
    east: centerLon + lonSpan / 2,
    south: Math.max(centerLat - latSpan / 2, -75),
    north: Math.min(centerLat + latSpan / 2, 85),
  };
}

function makeProjection(points) {
  const box = viewBox(points);
  const extent = [[PADDING, PADDING], [WIDTH - PADDING, HEIGHT - PADDING]];
  if (!box) {
    return geoNaturalEarth1().fitExtent(extent, { type: 'FeatureCollection', features: landFeatures });
  }
  // Outline of the box, sampled along its edges because it is curved once projected.
  const outline = [];
  for (let i = 0; i <= 10; i++) {
    const lon = box.west + ((box.east - box.west) * i) / 10;
    const lat = box.south + ((box.north - box.south) * i) / 10;
    outline.push([lon, box.south], [lon, box.north], [box.west, lat], [box.east, lat]);
  }
  return geoNaturalEarth1()
    .rotate([-box.centerLon, 0])
    .fitExtent(extent, { type: 'MultiPoint', coordinates: outline });
}

/** Spreads several dots in the same province out in a sunflower pattern around its point. */
function spread(x, y, index) {
  if (index === 0) return [x, y];
  const angle = index * 2.39996;
  const distance = DOT_RADIUS * 2.1 * Math.sqrt(index);
  return [x + distance * Math.cos(angle), y + distance * Math.sin(angle)];
}

export async function renderMapSvg(members) {
  const points = members.map((m) => [m.lon, m.lat]);
  const projection = makeProjection(points);
  const path = geoPath(projection).digits(1);

  const countryCodes = [...new Set(members.map((m) => m.countryCode))];
  const provinceShapes = [];
  for (const code of countryCodes) {
    const provinces = await getProvinces(code);
    if (provinces) provinceShapes.push(path(provinces));
  }

  const byProvince = new Map();
  const dots = [];
  // Oldest pins first so that a member's dot stays in place when others join.
  const sorted = [...members].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  for (const m of sorted) {
    const key = `${m.countryCode}/${m.provinceId}`;
    const index = byProvince.get(key) ?? 0;
    byProvince.set(key, index + 1);
    const projected = projection([m.lon, m.lat]);
    if (!projected) continue;
    const [x, y] = spread(projected[0], projected[1], index);
    dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${DOT_RADIUS}"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="100%" height="100%" fill="${COLORS.background}"/>
  <path d="${path({ type: 'Sphere' })}" fill="${COLORS.ocean}"/>
  <path d="${path({ type: 'FeatureCollection', features: landFeatures })}" fill="${COLORS.land}"/>
  <g fill="none" stroke="${COLORS.provinceBorder}" stroke-width="0.8" stroke-linejoin="round">
    ${provinceShapes.map((d) => `<path d="${d}"/>`).join('\n    ')}
  </g>
  <path d="${path({ type: 'FeatureCollection', features: landFeatures })}" fill="none" stroke="${COLORS.countryBorder}" stroke-width="1.2" stroke-linejoin="round"/>
  <g fill="${COLORS.dot}" stroke="${COLORS.dotStroke}" stroke-width="2.5">
    ${dots.join('\n    ')}
  </g>
</svg>`;
}

export async function renderMapPng(members) {
  const svg = await renderMapSvg(members);
  return new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
}
