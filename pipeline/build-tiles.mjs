// Builds data/dist/tiles/world.pmtiles — a single multi-layer vector-tile file
// the app serves statically (no tile server) via the pmtiles:// protocol.
//
// Layers inside the pmtiles:
//   countries  (from the slim 10m render geojson; keeps id+name for hit-testing)
//   land       (NE 10m land polygons — the physical basemap)
//   lakes      (NE 10m lakes)
//   rivers     (NE 10m river centrelines)
//
// Vector tiles keep detail crisp when zooming in and sidestep the worker stall
// that loading one large raw 10m GeoJSON caused.
import { mkdir, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const BUILD = join(ROOT, "data", "build");
const DIST = join(ROOT, "data", "dist");
const RENDER = join(DIST, "render");
const TILES = join(DIST, "tiles");
const MAPSHAPER = join(ROOT, "node_modules", ".bin", "mapshaper");

// Slim each physical layer down to the props we actually style on.
const PHYSICAL = [
  { layer: "land", src: "ne_10m_land.geojson", keep: [] },
  { layer: "lakes", src: "ne_10m_lakes.geojson", keep: ["name", "scalerank", "min_zoom"] },
  { layer: "rivers", src: "ne_10m_rivers_lake_centerlines.geojson", keep: ["name", "scalerank", "min_zoom"] },
];

async function need(path, hint) {
  try {
    await stat(path);
  } catch {
    throw new Error(`Missing ${path} — ${hint}`);
  }
}

async function slimPhysical() {
  await mkdir(BUILD, { recursive: true });
  const outputs = {};
  for (const { layer, src, keep } of PHYSICAL) {
    await need(join(RAW, src), "run `npm run data:download`");
    const out = join(BUILD, `${layer}.geojson`);
    // NB: `-filter-fields ""` (empty) makes mapshaper drop every FEATURE, not just
    // fields — so only pass the flag when we actually want to keep some props.
    const args = [join(RAW, src)];
    if (keep.length) args.push("-filter-fields", keep.join(","));
    args.push("-o", out, "format=geojson");
    await exec(MAPSHAPER, args);
    outputs[layer] = out;
    console.log(`  slim ${layer} (${keep.length ? keep.join(",") : "geometry only"})`);
  }
  return outputs;
}

async function buildTiles(physical) {
  await mkdir(TILES, { recursive: true });
  const countries = join(RENDER, "countries.10m.geojson");
  await need(countries, "run `npm run data:countries`");
  const out = join(TILES, "world.pmtiles");

  // -Z0 -z9: present from the whole-world view down to detailed zoom.
  // --no-tile-size-limit so no countries/features get dropped at low zoom.
  // --detect-shared-borders keeps adjacent country edges aligned when simplified.
  const args = [
    "-o", out,
    "-f",
    "-Z0", "-z9",
    "--no-tile-size-limit",
    "--detect-shared-borders",
    "--simplification=4",
    "-L", `countries:${countries}`,
    "-L", `land:${physical.land}`,
    "-L", `lakes:${physical.lakes}`,
    "-L", `rivers:${physical.rivers}`,
  ];
  await exec("tippecanoe", args, { maxBuffer: 64 * 1024 * 1024 });
  const { size } = await stat(out);
  console.log(`  tiles world.pmtiles (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  // sanity: tippecanoe present
  try {
    await exec("tippecanoe", ["--version"]);
  } catch {
    throw new Error("tippecanoe not found on PATH — `brew install tippecanoe`");
  }
  console.log("Slimming physical layers:");
  const physical = await slimPhysical();
  console.log("Building vector tiles:");
  await buildTiles(physical);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
