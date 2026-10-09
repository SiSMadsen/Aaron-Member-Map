import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const readJson = async (file) => JSON.parse(await readFile(path.join(DIR, file), 'utf8'));

const countries = new Map((await readJson('countries.json')).map((c) => [c.code, c]));
const provinceCache = new Map();

export const world = await readJson('world.json');

export function getCountry(code) {
  return countries.get(code) ?? null;
}

/** Province polygons of a country, or null for an unknown country code. */
export async function getProvinces(code) {
  if (!countries.has(code)) return null;
  if (!provinceCache.has(code)) provinceCache.set(code, readJson(path.join('provinces', `${code}.json`)));
  return provinceCache.get(code);
}

export async function findProvince(countryCode, provinceId) {
  const provinces = await getProvinces(countryCode);
  return provinces?.features.find((f) => f.properties.id === provinceId) ?? null;
}
