// Central registry of source layers + scales we pull from Natural Earth.
// We fetch the *pre-converted GeoJSON* from the nvkelso/natural-earth-vector
// mirror, which avoids needing GDAL / shapefile handling in the pipeline.
//
// Scales: 110m (coarse, tiny files, good default render), 50m (medium),
// 10m (detailed; will graduate to PMTiles vector tiles via tippecanoe later).

const RAW_BASE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";

/** @typedef {"110m"|"50m"|"10m"} Scale */

// Each entry: { key, file(scale) -> NE filename, scales: Scale[] }
export const LAYERS = [
  {
    key: "admin_0_countries",
    scales: ["110m", "50m", "10m"],
    file: (s) => `ne_${s}_admin_0_countries.geojson`,
  },
  // --- enabled in future feature waves -------------------------------------
  // map_units splits e.g. metropolitan France from overseas; useful later.
  {
    key: "admin_0_map_units",
    scales: ["50m", "10m"],
    file: (s) => `ne_${s}_admin_0_map_units.geojson`,
    enabled: false,
  },
  // admin-1 = states / provinces / regions subdivisions gamemode.
  {
    key: "admin_1_states_provinces",
    scales: ["10m"],
    file: (s) => `ne_${s}_admin_1_states_provinces.geojson`,
  },
  // cities gamemode: capitals + cities over a population threshold.
  {
    key: "populated_places",
    scales: ["10m"],
    file: (s) => `ne_${s}_populated_places.geojson`,
  },

  // --- physical layers (for the "physical" basemap + vector tiles) ----------
  { key: "land", scales: ["10m"], file: (s) => `ne_${s}_land.geojson` },
  { key: "lakes", scales: ["10m"], file: (s) => `ne_${s}_lakes.geojson` },
  {
    key: "rivers",
    scales: ["10m"],
    file: (s) => `ne_${s}_rivers_lake_centerlines.geojson`,
  },
];

export function rawUrl(file) {
  return `${RAW_BASE}/${file}`;
}

export function activeLayers() {
  return LAYERS.filter((l) => l.enabled !== false);
}
