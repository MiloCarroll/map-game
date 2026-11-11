// Builds data/dist/targets.cities.json — the truth data for the cities gamemode.
//
// Target set = every national capital (ADM0CAP=1) UNION every city with
// POP_MAX >= MIN_POP. Capitals are always included so small-country capitals
// (Vatican, Ngerulmud, ...) appear even when below the population threshold.
//
// Cities are points: the app hit-tests them by distance-to-centroid (the radius
// assist), so there's no render geometry beyond the point — this file doubles as
// the render source. Continent/region tags are joined from the countries data
// (NE populated_places has no CONTINENT/REGION_UN of its own).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw", "ne_10m_populated_places.geojson");
const DIST = join(ROOT, "data", "dist");

// Population threshold for non-capital cities. Tune here.
const MIN_POP = 1_000_000;

// Human-readable population, e.g. 9904000 -> "9.9M", 317797 -> "318k".
function fmtPop(n) {
  if (!n) return "unknown";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

async function main() {
  const [places, countries, factsCfg] = await Promise.all([
    readFile(RAW, "utf8").then(JSON.parse),
    readFile(join(DIST, "targets.countries.json"), "utf8").then(JSON.parse),
    readFile(join(ROOT, "pipeline", "config", "city-facts.json"), "utf8").then(JSON.parse),
  ]);

  // ADM0_A3 -> region tags, from the countries truth data.
  const regionByA3 = new Map(countries.features.map((c) => [c.id, c.regions]));
  const facts = factsCfg.facts || {};
  const usedFacts = new Set();

  const seen = new Set();
  const features = [];
  let capitals = 0;
  let byPop = 0;
  for (const f of places.features) {
    const p = f.properties;
    const isCapital = p.ADM0CAP === 1;
    const popMax = p.POP_MAX ?? 0;
    if (!isCapital && popMax < MIN_POP) continue;

    const id = String(p.NE_ID);
    if (seen.has(id)) continue;
    seen.add(id);
    if (isCapital) capitals++;
    else byPop++;

    const coords = f.geometry?.coordinates ?? [p.LONGITUDE, p.LATITUDE];
    const regions = regionByA3.get(p.ADM0_A3) ?? {
      continent: null,
      regionUN: null,
      subregion: null,
    };
    const name = (p.NAME || p.NAMEASCII).replace(/\s+/g, " ").trim();
    const country = p.ADM0NAME;
    // Compose the description: role + population, plus a curated fact if we have one.
    const role = isCapital ? `Capital of ${country}` : `City in ${country}`;
    const fact = facts[name];
    if (fact) usedFacts.add(name);
    const desc = `${role} · pop. ${fmtPop(popMax)}` + (fact ? ` · ${fact}` : "");
    features.push({
      id,
      name,
      country,
      adm0a3: p.ADM0_A3,
      centroid: [coords[0], coords[1]],
      regions: {
        continent: regions.continent,
        regionUN: regions.regionUN,
        subregion: regions.subregion,
      },
      status: { inDefaultQuiz: true, capital: isCapital, popMax },
      desc,
      kind: "city",
    });
  }

  features.sort((a, b) => a.name.localeCompare(b.name));
  const out = {
    type: "cities",
    source: "Natural Earth 1:10m populated_places",
    license: "Public domain (Natural Earth)",
    minPop: MIN_POP,
    count: features.length,
    features,
  };
  await writeFile(join(DIST, "targets.cities.json"), JSON.stringify(out, null, 2));
  console.log(`  targets.cities.json: ${features.length} cities`);
  console.log(`  ${capitals} capitals + ${byPop} non-capital cities (POP_MAX >= ${MIN_POP.toLocaleString()})`);
  console.log(`  facts attached: ${usedFacts.size}/${Object.keys(facts).length}`);
  const unmatched = Object.keys(facts).filter((k) => !usedFacts.has(k));
  if (unmatched.length) console.log(`  ⚠ fact keys matching no city (fix the name): ${unmatched.join(", ")}`);
  const noRegion = features.filter((f) => !f.regions.regionUN).length;
  if (noRegion) console.log(`  note: ${noRegion} cities have no region tag (country not in countries set — e.g. territories)`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
