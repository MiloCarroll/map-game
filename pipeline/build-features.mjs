// Builds data/dist/targets.geo-features.json from the curated config
// (pipeline/config/geo-features.json). Most features are point + radius, but
// RIVERS get the actual river line geometry pulled from Natural Earth
// (ne_10m_rivers_lake_centerlines), so the game hit-tests against the river line
// itself (within a tight tolerance) rather than a big radial blob.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG = join(ROOT, "pipeline", "config", "geo-features.json");
const RIVERS = join(ROOT, "data", "raw", "ne_10m_rivers_lake_centerlines.geojson");
const DIST = join(ROOT, "data", "dist");

// Click tolerance (km) for line targets — how close to the river line counts.
const RIVER_HIT_KM = 40;

// Feature id -> Natural Earth river name(s) whose segments make up that river.
const RIVER_NE_NAMES = {
  nile: ["Nile", "Victoria Nile", "Albert Nile"],
  "amazon-river": ["Amazonas"],
  mississippi: ["Mississippi"],
  yangtze: ["Yangtze", "Chang Jiang"],
  ganges: ["Ganges"],
  "danube-river": ["Danube"],
  "congo-river": ["Congo"],
  volga: ["Volga"],
  mekong: ["Mekong"],
  rhine: ["Rhine"],
  yellowriver: ["Huang"],
  "niger-river": ["Niger"],
  "colorado-river": ["Colorado"],
  murray: ["Murray"],
  zambezi: ["Zambezi"],
  brahmaputra: ["Brahmaputra"],
  parana: ["Paraná"],
  lena: ["Lena"],
};

// Round coords to ~5 decimals to keep the output compact.
const r5 = (n) => Math.round(n * 1e5) / 1e5;

async function buildRiverLineIndex() {
  const fc = JSON.parse(await readFile(RIVERS, "utf8"));
  const byName = new Map(); // NE name -> array of LineString coord arrays
  for (const f of fc.features) {
    const name = f.properties?.name;
    if (!name) continue;
    const g = f.geometry;
    const segs = g?.type === "LineString" ? [g.coordinates] : g?.type === "MultiLineString" ? g.coordinates : [];
    if (!segs.length) continue;
    if (!byName.has(name)) byName.set(name, []);
    for (const seg of segs) byName.get(name).push(seg.map(([x, y]) => [r5(x), r5(y)]));
  }
  return byName;
}

async function main() {
  const cfg = JSON.parse(await readFile(CFG, "utf8"));
  const riverIndex = await buildRiverLineIndex();
  const ids = new Set();
  const riversMatched = [];
  const riversMissing = [];

  const features = cfg.features.map((r) => {
    if (!r.id || !r.name || !Array.isArray(r.centroid) || typeof r.radiusKm !== "number") {
      throw new Error(`Invalid feature entry: ${JSON.stringify(r)}`);
    }
    if (ids.has(r.id)) throw new Error(`Duplicate feature id: ${r.id}`);
    ids.add(r.id);

    const out = {
      id: r.id,
      name: r.name,
      category: r.category ?? null,
      desc: r.desc ?? null,
      centroid: r.centroid,
      radiusKm: r.radiusKm,
      regions: { continent: r.regionUN, regionUN: r.regionUN ?? null, subregion: r.subregion ?? null },
      status: { inDefaultQuiz: true },
      kind: "feature",
    };

    // Rivers: attach the real line geometry; tighten the hit tolerance.
    if (r.category === "river" && RIVER_NE_NAMES[r.id]) {
      const line = RIVER_NE_NAMES[r.id].flatMap((nm) => riverIndex.get(nm) ?? []);
      if (line.length) {
        out.line = line;
        out.radiusKm = RIVER_HIT_KM;
        riversMatched.push(`${r.name}(${line.length})`);
      } else {
        riversMissing.push(r.name);
      }
    }
    return out;
  });
  features.sort((a, b) => a.name.localeCompare(b.name));

  const byCategory = {};
  for (const f of features) byCategory[f.category ?? "—"] = (byCategory[f.category ?? "—"] ?? 0) + 1;
  const out = {
    type: "geo-features",
    source: "Curated (pipeline/config/geo-features.json) + NE rivers for line geometry",
    count: features.length,
    features,
  };
  await writeFile(join(DIST, "targets.geo-features.json"), JSON.stringify(out));
  console.log(`  targets.geo-features.json: ${features.length} features`);
  console.log("  by category: " + Object.entries(byCategory).map(([k, v]) => `${k} ${v}`).join(", "));
  console.log(`  river lines attached: ${riversMatched.length} (${riversMatched.join(", ")})`);
  if (riversMissing.length) console.log(`  ⚠ rivers with no NE line match (still point+radius): ${riversMissing.join(", ")}`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
