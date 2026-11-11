// Builds data/dist/targets.geo-regions.json from the curated config
// (pipeline/config/geo-regions.json). Geographical regions are points + a radius
// (no precise borders), so this is just a validate-and-wrap step into the same
// target schema the app's other feature types use.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG = join(ROOT, "pipeline", "config", "geo-regions.json");
const DIST = join(ROOT, "data", "dist");

async function main() {
  const cfg = JSON.parse(await readFile(CFG, "utf8"));
  const ids = new Set();
  const features = cfg.regions.map((r) => {
    if (!r.id || !r.name || !Array.isArray(r.centroid) || typeof r.radiusKm !== "number") {
      throw new Error(`Invalid region entry: ${JSON.stringify(r)}`);
    }
    if (ids.has(r.id)) throw new Error(`Duplicate region id: ${r.id}`);
    ids.add(r.id);
    return {
      id: r.id,
      name: r.name,
      centroid: r.centroid,
      radiusKm: r.radiusKm,
      regions: { continent: r.regionUN, regionUN: r.regionUN, subregion: r.subregion ?? null },
      status: { inDefaultQuiz: true },
      kind: "region",
    };
  });
  features.sort((a, b) => a.name.localeCompare(b.name));
  const out = {
    type: "geo-regions",
    source: "Curated (pipeline/config/geo-regions.json)",
    count: features.length,
    features,
  };
  await writeFile(join(DIST, "targets.geo-regions.json"), JSON.stringify(out, null, 2));
  console.log(`  targets.geo-regions.json: ${features.length} regions`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
