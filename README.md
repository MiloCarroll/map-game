# map-game

A geography click-quiz: the player is shown a world map (2D projection **or** 3D
globe) and must click prompted countries — and later cities, regions, islands,
territories, etc. Inspired by Sporcle's "no-outlines minefield" quizzes.

## Architecture (decided)

- **Platform:** static web app. No backend for now — single-player, scores in
  `localStorage`, deployable to any static host.
- **Renderer:** [MapLibre GL JS](https://maplibre.org/) (v5+). One engine renders
  the same vector data as either a 2D projection **or** a 3D globe, with built-in
  zoom / pan / rotate, style switching, raster (satellite) layers, and per-layer
  toggles (borders on/off). No API keys, no per-load billing.
- **Data is fully self-hosted.** Sourced from public-domain
  [Natural Earth](https://www.naturalearthdata.com/) (via the
  [`nvkelso/natural-earth-vector`](https://github.com/nvkelso/natural-earth-vector)
  GeoJSON mirror, so no GDAL/shapefile handling needed).

### The core data split: render vs. truth

Every feature type produces **two** artifact families, kept deliberately separate:

| Artifact | Purpose | Format |
|---|---|---|
| **Render** | what MapLibre draws (fills, borders, physical layers) | `world.pmtiles` vector tiles (built by tippecanoe); slim GeoJSON kept for low-detail/debug |
| **Truth** (`targets.*.json`) | decides whether a click is correct | curated JSON: id, name, aliases, centroid, region tags, status flags, metrics |

Hit-testing happens in **geographic coordinates** (`map.unproject(click) → lng/lat`),
so it is identical in 2D and 3D. A click is correct if it falls **inside the
target polygon** (point-in-polygon, [Turf.js](https://turfjs.org/)) **OR within
N km of the centroid** — the radius branch is what makes microstates and cities
clickable.

## Data pipeline

```
data/raw/      downloaded Natural Earth GeoJSON   (gitignored, re-downloadable)
data/build/    intermediate slimmed physical layers (gitignored)
data/dist/     built artifacts the app consumes
  render/      countries.{110m,50m,10m}.geojson   (slim, simplified)
  tiles/       world.pmtiles                       (vector tiles: countries+land+lakes+rivers)
  targets.countries.json                          (truth data — countries)
  targets.cities.json                             (truth data — cities; doubles as render points)
  targets.geo-regions.json                        (truth data — geographical regions; point + radius)
  targets.geo-features.json                       (truth data — natural features; point/line + radius)
  admin1/<ADM0_A3>.json + index.json              (per-country subdivisions, loaded on demand)
pipeline/
  sources.mjs            source-layer + scale registry (toggle future layers here)
  download.mjs           fetch sources -> data/raw/
  build-countries.mjs    -> render geojson + targets.countries.json
  build-cities.mjs       -> targets.cities.json (capitals + cities >= MIN_POP)
  build-regions.mjs      -> targets.geo-regions.json (validate/wrap the curated list)
  build-features.mjs     -> targets.geo-features.json (+ river line geometry from NE rivers)
  build-admin1.mjs       -> admin1/<ADM0_A3>.json + index.json (states/provinces, per country)
  build-tiles.mjs        -> world.pmtiles (tippecanoe; countries + physical layers)
  config/
    un-members.json      authoritative country set: 193 UN members + 2 observers (by ISO-3)
    country-status.json  per-entity overrides (disputed flags, notes)
    geo-regions.json     curated geographical regions (Siberia, Anatolia, ...): centroid + radiusKm
    geo-features.json    curated natural features (Everest, Baikal, Mariana Trench, Uluru, ...)
    city-facts.json      one-line facts for ~85 well-known cities (keyed by name)
    regions.json         custom thematic groupings (Pacific Is., Balkans, ...)
```

### Run it

```bash
npm install
npm run data:build          # download + build everything (needs `tippecanoe` for tiles)
# or individually:
npm run data:download       # --force to re-fetch
npm run data:countries      # render geojson + targets.countries.json
npm run data:cities         # targets.cities.json (edit MIN_POP in build-cities.mjs to tune)
npm run data:regions        # targets.geo-regions.json (edit pipeline/config/geo-regions.json)
npm run data:features       # targets.geo-features.json (edit pipeline/config/geo-features.json)
npm run data:admin1         # admin1/<ADM0_A3>.json + index.json (states/provinces)
npm run data:tiles          # world.pmtiles (requires: brew install tippecanoe)
```

### `targets.countries.json` schema (per feature)

```jsonc
{
  "id": "FRA",                       // ADM0_A3, with fallback for NE's -99 sentinel
  "name": "France",
  "longName": "France",
  "aliases": [],
  "centroid": [2.55, 46.70],         // [lng, lat] from NE LABEL_X/LABEL_Y
  "regions": { "continent", "regionUN", "subregion", "regionWB" },
  "status": {
    "type": "Country",               // NE TYPE
    "sovereign", "disputed", "dependency",
    "unMember", "unObserver",        // matched against un-members.json
    "inDefaultQuiz": true,           // unMember || unObserver — the 195-country set
    "unrecognized": true             // present only for de-facto states (Taiwan, Somaliland…)
  },
  "metrics": { "popEst", "popRank", "scaleRank", "labelRank", "minZoom" },
  "iso": { "a2": "FR", "a3": "FRA", "n3": "250" }
}
```

The **country set is data-driven**: `un-members.json` is the authoritative list,
matched against each feature's canonicalized id (the build verifies all 193+2
matched a feature). `status` flags then let any gamemode include/exclude the
default 195, de-facto states (`unrecognized`), dependencies, or disputed
territories — no hardcoded list in the app. NE's `TYPE: "Country"` spans both
sovereign states (France) and autonomous territories (Greenland, Hong Kong), so
UN membership — not `TYPE` — is what decides sovereignty.

## Web app (`app/`)

A Vite + MapLibre app. Run it:

```bash
cd app
npm install
npm run flags      # copy flag SVGs (flag-icons, MIT) into public/flags
npm run dev        # http://localhost:5173
```

It reads the pipeline artifacts via `app/public/data` (a symlink to `data/dist`),
renders from the `world.pmtiles` vector tiles (`pmtiles://` protocol), and:

- **2D ↔ 3D globe** toggle (`map.setProjection`) — same data, one engine.
- **Vector tiles** keep coastlines/borders crisp at any zoom (vectors scale
  without pixelation; tiles go to z9, overzoomed beyond). Served as one static
  file via HTTP range requests — no tile server.
- **Basemap switcher** — *Simplified* (flat country fills), *Physical* (NE
  land/lakes/rivers — rivers widen with importance via `scalerank` — + a hillshade
  DEM for relief), *Satellite* (Sentinel-2 cloudless day imagery), *Night*
  (NASA "Earth at Night" / VIIRS city lights).
  A transparent-but-queryable country layer sits on top, so hit-testing is
  identical across all styles.
- **Click → hit-test → score**: countries must be hit by **polygon**
  (`queryRenderedFeatures`); cities by being within `acceptRadiusKm`. A non-scoring
  click is a **mistake only if it's on land AND beyond `forgivenessRadiusKm`** of the
  target — **ocean clicks and near-misses are neutral** (no point, no penalty).
  Correct → green; **wrong → a red ✗ flashes at the click** (every mode), plus the
  wrong polygon flashes red in country/subdivision modes; unfound items revealed orange at the end.
- **Flag overlay**: a found/revealed *country* gets its flag rendered as a badge
  centred on it (a symbol layer on the `flags` source). Flags are rasterized on
  demand from `/flags/<a2>.svg` (id→`iso.a2`→SVG) and added via `map.addImage`.
- **Persistent labels**: found/shown *cities and regions* keep their name above
  them (DOM `Marker` labels — no glyph fonts needed). Regions also get a
  translucent area circle (`@turf/circle` → the `region-areas` source).
- **Description banner** (`#feature-info`): found/shown *cities and features* show
  a one-line blurb. Cities auto-compose `Capital of/City in <country> · pop. <X>`
  (from the data) plus a curated fact from `city-facts.json` for ~85 well-known
  cities; features use their `desc`. Built in `build-cities.mjs`, which reports
  any fact key that matches no city.
- Borders on/off toggle, zoom/pan/rotate.

**Tile sources:** vector tiles (countries + physical layers) are **self-hosted**
from Natural Earth. The raster basemaps need external endpoints (impractical to
self-host): the **AWS terrain DEM** (Mapzen/Tilezen, public) drives the hillshade,
**Sentinel-2 cloudless** (EOX, CC BY 4.0) is the day satellite, and **NASA GIBS**
(VIIRS_CityLights_2012, public) is the night layer.

### Code layout (separation of concerns)

| File | Responsibility |
|---|---|
| `src/modes.ts` | `Mode` type + `buildPool` (region/set/city filtering). No presets — a `Mode` is built from the menu form. |
| `src/game.ts` | `GameEngine` — UI-agnostic state machine. Ordering, skip/return, reveal, mistakes, timer, win/lose. Knows nothing about MapLibre or the DOM. |
| `src/main.ts` | Wires the engine to MapLibre + DOM: the builder menu, rendering from `snapshot()`, click hit-testing, end screen. |

### The game builder (`Mode`)

The menu is a **customization form**, not a preset list: Country/City tabs over a
shared form that constructs a `Mode` on Start. A `Mode` is pure data:

```ts
{ id, label, description,
  featureType: "countries" | "cities" | "regions",
  ordering: "sequential" | "random" | "free",  // free = no prompt, find all in any order
  allowSkip, allowReturn,                       // skip current; does it come back?
  maxMistakes: number | null,                   // lose when exceeded; null = unlimited
  acceptRadiusKm,                               // cities: hit within this of the city = correct
  forgivenessRadiusKm,                          // wrong land click within this of target = not a mistake
  timerSeconds: number | null,
  regionFilter?,                                // { regionUN | continent | subregions | ids }
  includeUnrecognized?,                         // countries: add de-facto states
  cityFilter? }                                 // cities: { capitalsOnly, minPop }
```

Form controls map directly onto these fields: **Region** (dropdown grouped by
continent, with each continent's NE subregions — Caribbean, Western Europe,
Melanesia… — as `subregions` options, all populated from the data), **Order**,
**Mistakes allowed**, **Time limit**, **Wrong-click forgiveness**
(Strict / Normal / Lenient → `forgivenessRadiusKm`), **Allow skip & return**,
**Show borders**, plus **Include de-facto states** (countries),
**Capitals only** / **Min city population** (cities), and **Category**
(features — peaks, volcanoes, lakes, rivers, …). Pool comes
from the matching `targets.*.json` via `buildPool`. "Show borders" sets the initial
border visibility (still toggleable in-game). The end screen's **Play again**
replays the same `Mode`; **New game** returns to the builder.

**Five feature types, one engine.** Countries and **country subdivisions**
(states/provinces) hit-test by **polygon** (`queryRenderedFeatures`) — subdivisions
load per chosen country from `admin1/<ADM0_A3>.json` on demand (a Country picker in
the builder), rendered as outlined fills. There's an optional **radial hitbox** for
tiny / bad-polygon countries — `country-status.json` can set a `centroid` + `radiusKm` (used for
Vatican City and the Maldives, whose polygons are unusable). Cities, regions and
features are hit by **distance** — cities within `acceptRadiusKm` (50 km); regions
& most features within their own per-target `radiusKm`. **Rivers carry their real
line geometry** (pulled from NE rivers in `build-features.mjs`) and are hit-tested
by **distance to the line** (≤ 40 km) — you select the river itself, not a blob.
Country borders stay visible to help locate things. Found cities render as dots;
regions/features as a translucent area circle; **found rivers as a highlighted
line**; all keep a persistent name label. The **Features** set (`geo-features.json`, ~150 entries) spans peaks,
volcanoes, lakes, rivers, deserts, straits, trenches, canyons, waterfalls, islands
and one-off landmarks (Everest, Yellowstone, Lake Baikal, Mariana Trench, Uluru,
Darvaza, Eye of the Sahara, …); each carries a `category` (for the Category filter)
and a short `desc` shown in a banner when found/revealed. Rivers/straits are linear
so they use a representative point + generous radius.

**Pass (show)** — a learning aid distinct from Skip: `GameEngine.reveal()` gives
up the current prompt, eases the map to it, and surfaces its name — a persistent
label for cities/regions, a popup for countries. It's not a mistake; tracked as "Passed".

> **Region filtering uses `regionUN`, not `continent`** — NE's `CONTINENT` files
> island nations (Mauritius, Seychelles) under "Seven seas (open ocean)", which
> would drop them from an "Africa" filter; `REGION_UN` places them correctly (54).

## Roadmap (architecture supports, not yet built)

- **More feature types:** `admin_1_states_provinces` (regions), `admin_0_map_units`,
  islands/territories. Each gets a `build-*.mjs` emitting the same shape; a new
  `featureType` follows the cities pattern (point/polygon hit-test + render source).
- **Builder extras:** subregion/custom-group regions (the data + `RegionFilter`
  already support `subregions`/`ids` from `regions.json`); per-target accept radius
  that varies with city density; difficulty presets that pre-fill the form.
- **On-map labels:** add a glyph source so names can render on the map (today they
  appear only in the Pass popup).
- **Persistence:** remember the last builder config and best scores in `localStorage`.
- **Ethnic-group areas:** deferred (GeoEPR/GREG; specialized + politically sensitive).
