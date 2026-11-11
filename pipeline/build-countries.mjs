// Builds the COUNTRIES feature type into two artifact families:
//   1. render geojson  -> data/dist/render/countries.<scale>.geojson  (slim + simplified, for MapLibre)
//   2. truth targets    -> data/dist/targets.countries.json           (answer logic)
//
// Render and truth are deliberately separate (see project plan): the app draws
// from the render geojson / tiles, but decides correctness from targets.json.
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DIR = join(ROOT, "data", "raw");
const DIST_DIR = join(ROOT, "data", "dist");
const RENDER_DIR = join(DIST_DIR, "render");
const MAPSHAPER = join(ROOT, "node_modules", ".bin", "mapshaper");

// Properties we keep on the rendered features: enough for the app to style,
// filter by region, and run runtime point-in-polygon hit testing.
const KEEP_FIELDS = [
  "id", "name", "NAME_LONG", "ADM0_A3", "ISO_A2_EH", "ISO_A3_EH", "ISO_N3_EH",
  "TYPE", "SOVEREIGNT", "CONTINENT", "REGION_UN", "SUBREGION", "REGION_WB",
  "POP_EST", "POP_RANK", "scalerank", "LABELRANK", "MIN_ZOOM", "LABEL_X", "LABEL_Y",
];

// NE's ADM0_A3 (our id) differs from the ISO-3 code used in un-members.json for
// a couple of entities. Canonicalize the id before matching membership so that
// dependencies inheriting a parent's ISO code (e.g. Clipperton→FRA) never match.
const ID_TO_ISO3 = { SDS: "SSD", PSX: "PSE" };

// Per-scale vertex retention for -simplify (percentage of vertices to KEEP).
// 110m is already coarse so we leave it untouched.
const SIMPLIFY = { "110m": null, "50m": "30%", "10m": "12%" };

// Stable id: ADM0_A3 unless NE left it as the -99 sentinel, then fall back.
const ID_EXPR =
  'id = (ADM0_A3 && ADM0_A3 != "-99") ? ADM0_A3 : ' +
  '((ISO_A3_EH && ISO_A3_EH != "-99") ? ISO_A3_EH : (SU_A3 || ADM0_A3)); ' +
  "name = NAME_EN || NAME";

async function findScales() {
  const files = await readdir(RAW_DIR).catch(() => []);
  const scales = [];
  for (const s of ["110m", "50m", "10m"]) {
    if (files.includes(`ne_${s}_admin_0_countries.geojson`)) scales.push(s);
  }
  return scales;
}

async function buildRender(scale) {
  const src = join(RAW_DIR, `ne_${scale}_admin_0_countries.geojson`);
  const out = join(RENDER_DIR, `countries.${scale}.geojson`);
  const args = [src, "-each", ID_EXPR, "-filter-fields", KEEP_FIELDS.join(",")];
  if (SIMPLIFY[scale]) args.push("-simplify", "visvalingam", SIMPLIFY[scale], "keep-shapes");
  args.push("-o", out, "format=geojson");
  await exec(MAPSHAPER, args);
  return out;
}

function buildTargets(geojson, status, unData, scale) {
  const overrides = status.overrides || {};
  // Authoritative country set, matched against the feature's canonicalized id.
  const members = new Set(Object.values(unData.members).flat());
  const observers = new Set(Object.keys(unData.observers));
  const matchedMembers = new Set();
  const matchedObservers = new Set();

  const features = geojson.features.map((f) => {
    const p = f.properties;
    const ov = overrides[p.id] || {};

    // Match membership on the feature's OWN canonicalized id, not inherited ISO.
    const code = ID_TO_ISO3[p.id] ?? p.id;
    const unMember = members.has(code);
    const unObserver = observers.has(code);
    if (unMember) matchedMembers.add(code);
    if (unObserver) matchedObservers.add(code);
    // NE's TYPE "Country" covers both sovereign states (France) and autonomous
    // territories (Greenland, Hong Kong), so TYPE alone can't decide sovereignty —
    // UN membership is the discriminator. TYPE "Sovereign country" non-members are
    // the de-facto states (Taiwan, Somaliland, N. Cyprus).
    const sovereign = ov.sovereign ?? (unMember || unObserver || p.TYPE === "Sovereign country");
    const dependency = ov.dependency ?? p.TYPE === "Dependency";
    const disputed = ov.disputed ?? p.TYPE === "Disputed";
    const unrecognized = sovereign && !unMember && !unObserver;

    const aliases = [p.NAME_LONG, p.SOVEREIGNT]
      .filter((v) => v && v !== p.name)
      .filter((v, i, a) => a.indexOf(v) === i);
    return {
      id: p.id,
      name: p.name,
      longName: p.NAME_LONG,
      aliases,
      // Centroid override + radial hitbox for tiny / bad-polygon countries (Vatican, Maldives).
      centroid: ov.centroid ?? [p.LABEL_X, p.LABEL_Y],
      ...(ov.radiusKm != null ? { radiusKm: ov.radiusKm } : {}),
      regions: {
        continent: p.CONTINENT,
        regionUN: p.REGION_UN,
        subregion: p.SUBREGION,
        regionWB: p.REGION_WB,
      },
      status: {
        type: p.TYPE,
        sovereign,
        disputed,
        dependency,
        unMember,
        unObserver,
        // True for the default "countries" quiz set: 193 members + 2 observers.
        inDefaultQuiz: unMember || unObserver,
        ...(unrecognized ? { unrecognized: true } : {}),
        ...(ov.note ? { note: ov.note } : {}),
      },
      metrics: {
        popEst: p.POP_EST,
        popRank: p.POP_RANK,
        scaleRank: p.scalerank,
        labelRank: p.LABELRANK,
        minZoom: p.MIN_ZOOM,
      },
      iso: { a2: p.ISO_A2_EH, a3: p.ISO_A3_EH, n3: p.ISO_N3_EH },
    };
  });
  // Stable, deterministic order: by name.
  features.sort((a, b) => a.name.localeCompare(b.name));

  const report = {
    membersMatched: matchedMembers.size,
    membersTotal: members.size,
    unmatchedMembers: [...members].filter((c) => !matchedMembers.has(c)).sort(),
    observersMatched: matchedObservers.size,
    observersTotal: observers.size,
    unmatchedObservers: [...observers].filter((c) => !matchedObservers.has(c)).sort(),
  };
  const targets = {
    type: "countries",
    source: `Natural Earth 1:${scale} admin_0_countries`,
    license: "Public domain (Natural Earth)",
    count: features.length,
    defaultQuizCount: features.filter((f) => f.status.inDefaultQuiz).length,
    features,
  };
  return { targets, report };
}

async function main() {
  await mkdir(RENDER_DIR, { recursive: true });
  const scales = await findScales();
  if (!scales.length) {
    throw new Error("No country source files in data/raw — run `npm run data:download` first.");
  }
  console.log(`Building render geojson for scales: ${scales.join(", ")}`);
  let slimByScale = {};
  for (const s of scales) {
    const out = await buildRender(s);
    slimByScale[s] = out;
    console.log(`  render countries.${s}.geojson`);
  }

  // Build targets from the FINEST available scale (most complete feature list).
  const finest = scales[scales.length - 1];
  const cfg = (name) => readFile(join(ROOT, "pipeline", "config", name), "utf8").then(JSON.parse);
  const [status, unData] = await Promise.all([cfg("country-status.json"), cfg("un-members.json")]);
  const slim = JSON.parse(await readFile(slimByScale[finest], "utf8"));
  const { targets, report } = buildTargets(slim, status, unData, finest);
  const targetsPath = join(DIST_DIR, "targets.countries.json");
  await writeFile(targetsPath, JSON.stringify(targets, null, 2));

  console.log(`  targets.countries.json: ${targets.count} features (from ${finest})`);
  console.log(`  default quiz set: ${targets.defaultQuizCount} (expected 195 = 193 members + 2 observers)`);
  console.log(
    `  UN members matched: ${report.membersMatched}/${report.membersTotal}` +
      `, observers: ${report.observersMatched}/${report.observersTotal}`,
  );
  if (report.unmatchedMembers.length)
    console.log(`  ⚠ unmatched member codes (not found on map): ${report.unmatchedMembers.join(", ")}`);
  if (report.unmatchedObservers.length)
    console.log(`  ⚠ unmatched observer codes: ${report.unmatchedObservers.join(", ")}`);
  if (!report.unmatchedMembers.length && !report.unmatchedObservers.length)
    console.log("  ✓ every UN member + observer matched a feature.");
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
