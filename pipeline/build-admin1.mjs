// Builds the country-subdivisions (admin-1: states / provinces / regions) data
// from Natural Earth ne_10m_admin_1_states_provinces.
//
// Output (one file per country, loaded on demand by the app — keeps the main
// tiles small):
//   data/dist/admin1/<ADM0_A3>.geojson   slim, simplified polygons (id, name, lng, lat)
//   data/dist/admin1/index.json          [{ adm0a3, country, count }] for countries with >= MIN_SUB
//
// Subdivisions are hit-tested by polygon (like countries), so the geojson is both
// the render source and the truth (centroid from NE's label lng/lat).
import { mkdir, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw", "ne_10m_admin_1_states_provinces.geojson");
const OUT = join(ROOT, "data", "dist", "admin1");
const MAPSHAPER = join(ROOT, "node_modules", ".bin", "mapshaper");

// Only offer countries with at least this many named subdivisions.
const MIN_SUB = 4;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // Slim + simplify, then split into one GeoJSON per country (named <adm0_a3>.geojson).
  await exec(
    MAPSHAPER,
    [
      RAW,
      "-filter", 'name != null && name !== ""',
      "-each", "id = adm1_code; name = name_en || name; lng = +longitude; lat = +latitude",
      "-filter-fields", "id,name,lng,lat,adm0_a3,admin",
      "-simplify", "15%", "keep-shapes",
      "-split", "adm0_a3",
      "-o", OUT, "format=geojson",
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );

  // Build the picker index from the per-country files (mapshaper -split writes <adm0_a3>.json).
  const files = (await readdir(OUT)).filter((f) => f.endsWith(".json") && f !== "index.json");
  const index = [];
  for (const f of files) {
    const fc = JSON.parse(await readFile(join(OUT, f), "utf8"));
    const feats = fc.features || [];
    if (feats.length < MIN_SUB) continue;
    const adm0a3 = f.replace(/\.json$/, "");
    const country = feats[0]?.properties?.admin ?? adm0a3;
    index.push({ adm0a3, country, count: feats.length });
  }
  index.sort((a, b) => a.country.localeCompare(b.country));
  await writeFile(join(OUT, "index.json"), JSON.stringify(index));

  console.log(`  admin1: ${files.length} country files written`);
  console.log(`  index: ${index.length} countries with >= ${MIN_SUB} subdivisions`);
  const top = [...index].sort((a, b) => b.count - a.count).slice(0, 6).map((c) => `${c.country}(${c.count})`);
  console.log(`  largest: ${top.join(", ")}`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
