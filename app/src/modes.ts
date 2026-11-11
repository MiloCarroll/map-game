// A Mode is a point in the game's option space. The menu (main.ts) builds one
// from the customization form; the engine (game.ts) reads it. No presets — every
// field below is a control in the builder.

export type Ordering =
  | "sequential" // fixed order (alphabetical); find the prompted target
  | "random" // randomized order; find the prompted target
  | "free"; // no prompt — find every target in any order

/** Narrows the target pool to a region/subset. All fields are ANDed. */
export interface RegionFilter {
  // Prefer regionUN over continent for continent-scale grouping: NE's CONTINENT
  // files island nations (Mauritius, Seychelles…) under "Seven seas (open ocean)",
  // whereas REGION_UN places them correctly.
  regionUN?: string; // NE REGION_UN, e.g. "Africa"
  continent?: string; // NE CONTINENT
  subregions?: string[]; // NE SUBREGION
  ids?: string[]; // explicit ADM0_A3 allow-list
}

export interface Mode {
  id: string;
  label: string;
  description: string;
  featureType: "countries" | "cities" | "regions" | "features" | "subdivisions";
  ordering: Ordering;
  allowSkip: boolean; // can the prompted target be skipped?
  allowReturn: boolean; // do skipped targets come back later?
  maxMistakes: number | null; // lose when mistakes EXCEED this; null = unlimited
  acceptRadiusKm: number; // cities: click within this of the city counts as correct
  forgivenessRadiusKm: number; // a wrong land click within this of the target is NOT a mistake (ocean never is)
  timerSeconds: number | null; // null = untimed
  regionFilter?: RegionFilter;
  includeUnrecognized?: boolean; // countries: also include de-facto states (Taiwan, Kosovo…)
  cityFilter?: { capitalsOnly?: boolean; minPop?: number }; // cities only
  featureFilter?: { category?: string }; // features only ("" / undefined = all categories)
  subdivisionCountry?: string; // subdivisions only: ADM0_A3 of the country to quiz
}

export interface PoolTarget {
  id: string;
  regions: { continent: string; subregion: string; regionUN: string };
  status: { inDefaultQuiz: boolean; capital?: boolean; popMax?: number; unrecognized?: boolean };
  category?: string | null;
}

/** Selects the target pool for a mode from a feature type's full target list. */
export function buildPool<T extends PoolTarget>(targets: T[], mode: Mode, drawnIds: Set<string>): T[] {
  // Base set: the default quiz set, optionally plus de-facto states.
  let pool = targets.filter(
    (t) => (t.status.inDefaultQuiz || (mode.includeUnrecognized && t.status.unrecognized)) && drawnIds.has(t.id),
  );
  const rf = mode.regionFilter;
  if (rf?.regionUN) pool = pool.filter((t) => t.regions.regionUN === rf.regionUN);
  if (rf?.continent) pool = pool.filter((t) => t.regions.continent === rf.continent);
  if (rf?.subregions) pool = pool.filter((t) => rf.subregions!.includes(t.regions.subregion));
  if (rf?.ids) pool = pool.filter((t) => rf.ids!.includes(t.id));
  if (mode.featureType === "cities") {
    const cf = mode.cityFilter ?? {};
    if (cf.capitalsOnly) pool = pool.filter((t) => t.status.capital);
    // Non-capitals are kept only if they meet the population threshold; capitals
    // are always kept (the data is already pre-filtered to capitals + >= 1M).
    else if (cf.minPop != null) pool = pool.filter((t) => t.status.capital || (t.status.popMax ?? 0) >= cf.minPop!);
  }
  if (mode.featureType === "features" && mode.featureFilter?.category) {
    pool = pool.filter((t) => t.category === mode.featureFilter!.category);
  }
  return pool;
}
