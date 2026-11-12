import maplibregl, { type StyleSpecification, type ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import circle from "@turf/circle";
import "./style.css";
import { buildPool, type Mode, type Ordering } from "./modes";
import { GameEngine, type Target, type GameSnapshot, type GuessOutcome } from "./game";

interface TargetsFile {
  features: Target[];
}

// Self-hosted vector tiles (countries + physical land/lakes/rivers). Served as a
// single static file via HTTP range requests through the pmtiles:// protocol.
// BASE_URL is "/" in dev and "/map-game/" on GitHub Pages.
const BASE = import.meta.env.BASE_URL;
const TILES_URL = `pmtiles://${new URL(`${BASE}data/tiles/world.pmtiles`, location.href).href}`;
// External raster basemaps (impractical to self-host). Best-effort: require internet.
const SATELLITE_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/{z}/{y}/{x}.jpg";
const TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
// NASA GIBS "Earth at Night" (VIIRS city lights) — the night-time counterpart to the day satellite.
const NIGHT_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg";

type Basemap = "simplified" | "physical" | "satellite" | "night";
const BASEMAPS: Basemap[] = ["simplified", "physical", "satellite", "night"];

const els = {
  prompt: document.getElementById("prompt")!,
  score: document.getElementById("score")!,
  overlay: document.getElementById("overlay")!,
  featureInfo: document.getElementById("feature-info")!,
  toggleBasemap: document.getElementById("toggle-basemap") as HTMLButtonElement,
  toggleProjection: document.getElementById("toggle-projection") as HTMLButtonElement,
  toggleBorders: document.getElementById("toggle-borders") as HTMLButtonElement,
  skip: document.getElementById("skip") as HTMLButtonElement,
  pass: document.getElementById("pass") as HTMLButtonElement,
  quit: document.getElementById("quit") as HTMLButtonElement,
};

async function loadJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

// Game-state coloring for the (always-queryable) country layer.
const STATE: ExpressionSpecification = ["feature-state", "status"];
const FILL_COLOR: ExpressionSpecification = [
  "case",
  ["==", STATE, "found"], "#2e7d32",
  ["==", STATE, "wrong"], "#c62828",
  ["==", STATE, "revealed"], "#f9a825",
  "#e8e2d4",
];
// Opacity: state-marked countries always show; default opacity varies by basemap
// (opaque tan in simplified; transparent over physical/satellite imagery).
const fillOpacity = (base: number): ExpressionSpecification => [
  "case",
  ["any", ["==", STATE, "found"], ["==", STATE, "wrong"], ["==", STATE, "revealed"]],
  0.85,
  base,
];

function buildStyle(): StyleSpecification {
  return {
    version: 8,
    projection: { type: "globe" }, // default view; toggle switches to mercator
    sources: {
      world: { type: "vector", url: TILES_URL, promoteId: { countries: "id" } },
      satellite: {
        type: "raster",
        tiles: [SATELLITE_URL],
        tileSize: 256,
        attribution: "Sentinel-2 cloudless (EOX IT Services, CC BY 4.0)",
      },
      nightsat: {
        type: "raster",
        tiles: [NIGHT_URL],
        tileSize: 256,
        maxzoom: 8,
        attribution: "Earth at Night — NASA Earth Observatory / GIBS",
      },
      terrain: {
        type: "raster-dem",
        tiles: [TERRAIN_URL],
        tileSize: 256,
        maxzoom: 12,
        encoding: "terrarium",
        attribution: "Terrain: AWS Open Data (Mapzen/Tilezen)",
      },
      // City points; data is set at load from targets.cities.json. Dots are
      // invisible until a feature-state (found/revealed) is applied.
      cities: { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" },
      // Flag-badge points for found/revealed countries — appended as they resolve.
      flags: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      // Translucent area circles for found/revealed geographical regions.
      "region-areas": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      // Highlighted river lines for found/revealed river features.
      "feature-lines": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      // Subdivisions of the chosen country (loaded on demand in subdivisions mode).
      admin1: { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" },
    },
    layers: [
      { id: "ocean", type: "background", paint: { "background-color": "#9fc4dd" } },
      { id: "satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
      { id: "nightsat", type: "raster", source: "nightsat", layout: { visibility: "none" } },
      {
        id: "land-fill",
        type: "fill",
        source: "world",
        "source-layer": "land",
        layout: { visibility: "none" },
        paint: { "fill-color": "#e6dcc3" },
      },
      {
        id: "hillshade",
        type: "hillshade",
        source: "terrain",
        layout: { visibility: "none" },
        paint: { "hillshade-exaggeration": 0.4, "hillshade-shadow-color": "#5a4a32" },
      },
      {
        id: "lakes-fill",
        type: "fill",
        source: "world",
        "source-layer": "lakes",
        layout: { visibility: "none" },
        paint: { "fill-color": "#9fc4dd" },
      },
      {
        id: "rivers-line",
        type: "line",
        source: "world",
        "source-layer": "rivers",
        layout: { visibility: "none", "line-cap": "round" },
        paint: {
          "line-color": "#5a93c0",
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0, 2, 0.25, 5, 0.8],
          // Width varies with the river's importance (NE scalerank: 0 = major … 10 = minor) and zoom.
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            2, ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "scalerank"]], 10], 0, 1.2, 5, 0.5, 10, 0.2],
            6, ["interpolate", ["linear"], ["coalesce", ["to-number", ["get", "scalerank"]], 10], 0, 4, 5, 1.6, 10, 0.7],
          ],
        },
      },
      {
        id: "country-fill",
        type: "fill",
        source: "world",
        "source-layer": "countries",
        paint: { "fill-color": FILL_COLOR, "fill-opacity": fillOpacity(0.9) },
      },
      {
        id: "country-line",
        type: "line",
        source: "world",
        "source-layer": "countries",
        paint: { "line-color": "#ffffff", "line-width": 0.6 },
      },
      {
        // Subdivisions of the selected country (subdivisions mode). Queryable fill
        // (transparent until found/revealed) + faint outlines so the divisions show.
        id: "admin1-fill",
        type: "fill",
        source: "admin1",
        paint: {
          "fill-color": FILL_COLOR,
          "fill-opacity": ["case", ["any", ["==", STATE, "found"], ["==", STATE, "wrong"], ["==", STATE, "reveal"]], 0.8, 0],
        },
      },
      {
        id: "admin1-line",
        type: "line",
        source: "admin1",
        paint: { "line-color": "#7a6f5a", "line-width": 0.6, "line-opacity": 0.6 },
      },
      {
        id: "region-areas",
        type: "fill",
        source: "region-areas",
        paint: {
          "fill-color": ["case", ["==", ["get", "status"], "revealed"], "#f9a825", "#2e7d32"],
          "fill-opacity": 0.25,
          "fill-outline-color": ["case", ["==", ["get", "status"], "revealed"], "#f9a825", "#2e7d32"],
        },
      },
      {
        id: "feature-lines",
        type: "line",
        source: "feature-lines",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["case", ["==", ["get", "status"], "revealed"], "#f9a825", "#2e7d32"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 2, 6, 4.5],
          "line-opacity": 0.95,
        },
      },
      {
        id: "city-dots",
        type: "circle",
        source: "cities",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3.5, 6, 7],
          "circle-color": [
            "case",
            ["==", STATE, "found"], "#2e7d32",
            ["==", STATE, "revealed"], "#f9a825",
            "rgba(0,0,0,0)",
          ],
          "circle-opacity": ["case", ["any", ["==", STATE, "found"], ["==", STATE, "revealed"]], 1, 0],
          "circle-stroke-width": ["case", ["any", ["==", STATE, "found"], ["==", STATE, "revealed"]], 1.6, 0],
          "circle-stroke-color": "#ffffff",
        },
      },
      {
        // Flag badge centered on each found/revealed country. icon-image is the
        // per-feature id "flag-<ADM0_A3>"; the image is added on demand.
        id: "country-flag-badges",
        type: "symbol",
        source: "flags",
        layout: {
          "icon-image": ["concat", "flag-", ["get", "id"]],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 5, 1],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
    ],
  };
}

function fmtTime(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function main() {
  maplibregl.addProtocol("pmtiles", new Protocol().tile);

  const [countriesT, citiesT, regionsT, featuresT, admin1Index] = await Promise.all([
    loadJSON<TargetsFile>(BASE + "data/targets.countries.json"),
    loadJSON<TargetsFile>(BASE + "data/targets.cities.json"),
    loadJSON<TargetsFile>(BASE + "data/targets.geo-regions.json"),
    loadJSON<TargetsFile>(BASE + "data/targets.geo-features.json"),
    loadJSON<{ adm0a3: string; country: string; count: number }[]>(BASE + "data/admin1/index.json").catch(() => []),
  ]);
  // Subdivisions load on demand (per country), so their preloaded lists are empty.
  const targetsByType: Record<Mode["featureType"], Target[]> = {
    countries: countriesT.features,
    cities: citiesT.features,
    regions: regionsT.features,
    features: featuresT.features,
    subdivisions: [],
  };
  // All targets are present on the map (10m country tiles / all point targets).
  const drawnByType: Record<Mode["featureType"], Set<string>> = {
    countries: new Set(countriesT.features.map((t) => t.id)),
    cities: new Set(citiesT.features.map((t) => t.id)),
    regions: new Set(regionsT.features.map((t) => t.id)),
    features: new Set(featuresT.features.map((t) => t.id)),
    subdivisions: new Set(),
  };
  // Render source for cities (invisible until a found/revealed state is set).
  const cityFC: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: citiesT.features.map((c) => ({
      type: "Feature",
      id: c.id,
      geometry: { type: "Point", coordinates: c.centroid },
      properties: { id: c.id, name: c.name },
    })),
  };

  // Region dropdown options + city population floor, derived from the data.
  const REGIONS = [
    ...new Set(
      [...targetsByType.countries, ...targetsByType.cities]
        .filter((t) => t.status.inDefaultQuiz && t.regions.regionUN)
        .map((t) => t.regions.regionUN),
    ),
  ].sort();
  const cityMinPop = (citiesT as unknown as { minPop?: number }).minPop ?? 1_000_000;
  // Distinct feature categories (peak, volcano, lake, …) for the category filter.
  const FEATURE_CATEGORIES = [...new Set(featuresT.features.map((t) => t.category).filter(Boolean))].sort() as string[];

  // Country id (ADM0_A3) -> ISO alpha-2, for locating the flag SVG. Plus the
  // continent -> subregions map that powers the Region dropdown's optgroups.
  const a2ById = new Map(
    countriesT.features.map((c) => [c.id, (c as unknown as { iso?: { a2?: string } }).iso?.a2]),
  );
  const subByRegion = new Map<string, Set<string>>();
  for (const t of [...targetsByType.countries, ...targetsByType.cities]) {
    if (!t.status.inDefaultQuiz || !t.regions.regionUN || !t.regions.subregion) continue;
    if (!subByRegion.has(t.regions.regionUN)) subByRegion.set(t.regions.regionUN, new Set());
    subByRegion.get(t.regions.regionUN)!.add(t.regions.subregion);
  }

  const map = new maplibregl.Map({
    container: "map",
    style: buildStyle(),
    center: [10, 25],
    zoom: 1.4,
    renderWorldCopies: false,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  (window as unknown as { __map: maplibregl.Map }).__map = map; // dev handle

  // --- basemap switching ---------------------------------------------------
  const setVis = (id: string, on: boolean) =>
    map.setLayoutProperty(id, "visibility", on ? "visible" : "none");

  let basemap: Basemap = "simplified";
  function applyBasemap(kind: Basemap) {
    basemap = kind;
    const cfg = {
      simplified: { ocean: "#9fc4dd", phys: false, sat: false, night: false, fillBase: 0.9, border: "#ffffff", borderW: 0.6 },
      physical: { ocean: "#aacbe2", phys: true, sat: false, night: false, fillBase: 0, border: "#6b6b6b", borderW: 0.8 },
      satellite: { ocean: "#0b1c2c", phys: false, sat: true, night: false, fillBase: 0, border: "#ffd23f", borderW: 0.9 },
      night: { ocean: "#01030a", phys: false, sat: false, night: true, fillBase: 0, border: "#5ec8ff", borderW: 0.8 },
    }[kind];
    map.setPaintProperty("ocean", "background-color", cfg.ocean);
    setVis("satellite", cfg.sat);
    setVis("nightsat", cfg.night);
    setVis("hillshade", cfg.phys);
    setVis("land-fill", cfg.phys);
    setVis("lakes-fill", cfg.phys);
    setVis("rivers-line", cfg.phys);
    map.setPaintProperty("country-fill", "fill-opacity", fillOpacity(cfg.fillBase));
    if (bordersOn) map.setPaintProperty("country-line", "line-color", cfg.border);
    map.setPaintProperty("country-line", "line-width", cfg.borderW);
    els.toggleBasemap.textContent = `Map: ${kind[0].toUpperCase()}${kind.slice(1)}`;
  }

  // --- game state ----------------------------------------------------------
  let engine: GameEngine | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let revealPopup: maplibregl.Popup | null = null;
  let builderTab: Mode["featureType"] = "countries";
  const foundIds = new Set<string>();
  let flagFeatures: GeoJSON.Feature[] = [];
  let regionAreaFeatures: GeoJSON.Feature[] = [];
  let featureLineFeatures: GeoJSON.Feature[] = [];
  const labelMarkers = new Map<string, maplibregl.Marker>(); // persistent name labels for found/shown places

  const featureType = () => engine?.mode.featureType ?? "countries";
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const clearStates = () => {
    map.removeFeatureState({ source: "world", sourceLayer: "countries" });
    map.removeFeatureState({ source: "cities" });
    map.removeFeatureState({ source: "admin1" });
    foundIds.clear();
    flagFeatures = [];
    regionAreaFeatures = [];
    featureLineFeatures = [];
    const empty = { type: "FeatureCollection" as const, features: [] };
    (map.getSource("flags") as maplibregl.GeoJSONSource | undefined)?.setData(empty);
    (map.getSource("region-areas") as maplibregl.GeoJSONSource | undefined)?.setData(empty);
    (map.getSource("feature-lines") as maplibregl.GeoJSONSource | undefined)?.setData(empty);
    (map.getSource("admin1") as maplibregl.GeoJSONSource | undefined)?.setData(empty);
    labelMarkers.forEach((m) => m.remove());
    labelMarkers.clear();
    els.featureInfo.textContent = "";
    revealPopup?.remove();
    revealPopup = null;
  };

  // Persistent name label above a found/shown place (cities + regions).
  function addLabel(t: Target, status: "found" | "revealed") {
    if (labelMarkers.has(t.id)) return;
    const el = document.createElement("div");
    el.className = `place-label ${status}`;
    el.textContent = t.name;
    const marker = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -7] })
      .setLngLat(t.centroid)
      .addTo(map);
    labelMarkers.set(t.id, marker);
  }

  // Translucent area circle for a found/shown geographical region.
  function addRegionArea(t: Target, status: "found" | "revealed") {
    if (t.radiusKm == null) return;
    const poly = circle(t.centroid, t.radiusKm, { units: "kilometers", steps: 48 });
    poly.properties = { id: t.id, status };
    regionAreaFeatures.push(poly);
    (map.getSource("region-areas") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: regionAreaFeatures,
    });
  }

  // Highlighted line for a found/shown river feature.
  function addFeatureLine(t: Target, status: "found" | "revealed") {
    if (!t.line) return;
    featureLineFeatures.push({
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: t.line },
      properties: { id: t.id, status },
    });
    (map.getSource("feature-lines") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: featureLineFeatures,
    });
  }

  // Render a region/feature target: a river draws its line, everything else an area circle.
  function addAreaOrLine(t: Target, status: "found" | "revealed") {
    if (t.line) addFeatureLine(t, status);
    else addRegionArea(t, status);
  }

  // Show the most recently found/shown feature's blurb (no-op without a desc).
  function showFeatureInfo(t: Target) {
    if (t.desc) els.featureInfo.innerHTML = `<b>${t.name}</b> — ${t.desc}`;
  }

  // Flash a transient red ✗ at a wrong click (feedback in every mode).
  function flashWrongMark(lngLat: maplibregl.LngLatLike) {
    const el = document.createElement("div");
    el.className = "wrong-mark";
    el.textContent = "✗";
    const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    setTimeout(() => marker.remove(), 800);
  }

  // Rasterize a flag SVG and register it as a MapLibre image "flag-<id>".
  async function ensureFlag(id: string): Promise<boolean> {
    const imageId = `flag-${id}`;
    if (map.hasImage(imageId)) return true;
    const a2 = a2ById.get(id);
    if (!a2 || a2 === "-99") return false;
    try {
      let svg = await (await fetch(`${BASE}flags/${a2.toLowerCase()}.svg`)).text();
      if (!/<svg[^>]*\swidth=/.test(svg)) svg = svg.replace("<svg", '<svg width="640" height="480"');
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("flag load"));
        img.src = url;
      });
      URL.revokeObjectURL(url);
      const w = 60, h = 45;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, w, h);
      map.addImage(imageId, ctx.getImageData(0, 0, w, h), { pixelRatio: 2 });
      return true;
    } catch {
      return false; // missing/odd flag — fall back to the plain fill
    }
  }

  // Add a flag badge at a country's centroid (no-op for cities or missing flags).
  async function addFlagBadge(t: Target) {
    if (t.kind === "city") return;
    if (!(await ensureFlag(t.id))) return;
    flagFeatures.push({ type: "Feature", id: t.id, geometry: { type: "Point", coordinates: t.centroid }, properties: { id: t.id } });
    (map.getSource("flags") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: flagFeatures });
  }

  function renderHud(snap: GameSnapshot) {
    const isFree = engine!.mode.ordering === "free";
    const noun = { countries: "country", cities: "city", regions: "region", features: "feature", subdivisions: "subdivision" }[engine!.mode.featureType];
    els.prompt.innerHTML = isFree
      ? `Click every ${noun}`
      : snap.currentTarget
        ? `Find: <span class="target">${snap.currentTarget.name}</span>`
        : "";
    const parts = [`Found ${snap.foundCount} / ${snap.total}`];
    if (snap.revealedCount > 0) parts.push(`Passed ${snap.revealedCount}`);
    parts.push(snap.maxMistakes != null ? `Mistakes ${snap.mistakes}/${snap.maxMistakes}` : `Mistakes ${snap.mistakes}`);
    if (snap.timeLeftMs != null) parts.push(`⏱ ${fmtTime(snap.timeLeftMs)}`);
    els.score.innerHTML = parts.join(" · ");
  }

  const setState = (id: string, status: string | null) => {
    const ft = featureType();
    if (ft === "cities") map.setFeatureState({ source: "cities", id }, { status });
    else if (ft === "subdivisions") map.setFeatureState({ source: "admin1", id }, { status });
    else map.setFeatureState({ source: "world", sourceLayer: "countries", id }, { status });
  };

  // Pass / reveal: mark the target shown, ease to it, and surface its name.
  // Cities & regions get a persistent label; countries get a transient popup.
  function pass() {
    if (!engine) return;
    const t = engine.reveal();
    if (!t) return;
    const ft = featureType();
    if (ft === "countries") {
      setState(t.id, "revealed");
      void addFlagBadge(t);
      revealPopup?.remove();
      revealPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 10 })
        .setLngLat(t.centroid)
        .setHTML(`<div class="reveal-popup"><b>${t.name}</b></div>`)
        .addTo(map);
    } else if (ft === "cities" || ft === "subdivisions") {
      setState(t.id, "revealed");
      addLabel(t, "revealed");
    } else {
      addAreaOrLine(t, "revealed");
      addLabel(t, "revealed");
    }
    showFeatureInfo(t);
    const revealZoom = ft === "regions" ? 2.8 : ft === "features" ? 4 : ft === "cities" ? 4.5 : ft === "subdivisions" ? map.getZoom() : 3.2;
    map.easeTo({ center: t.centroid, zoom: Math.max(map.getZoom(), revealZoom), duration: 700 });
    const snap = engine.snapshot();
    renderHud(snap);
    if (snap.phase !== "playing") finish(snap);
  }

  function applyOutcome(o: GuessOutcome) {
    if (o.kind === "correct") {
      foundIds.add(o.target.id);
      const ft = featureType();
      if (ft === "countries") {
        setState(o.target.id, "found");
        void addFlagBadge(o.target);
      } else if (ft === "cities" || ft === "subdivisions") {
        setState(o.target.id, "found");
        addLabel(o.target, "found");
      } else {
        addAreaOrLine(o.target, "found");
        addLabel(o.target, "found");
      }
      showFeatureInfo(o.target);
    } else if (o.kind === "wrong" && (featureType() === "countries" || featureType() === "subdivisions") && o.clickedId && !foundIds.has(o.clickedId)) {
      // Flash the wrong polygon (countries / subdivisions).
      const id = o.clickedId;
      setState(id, "wrong");
      setTimeout(() => {
        if (!foundIds.has(id)) setState(id, null);
      }, 700);
    }
  }

  function finish(snap: GameSnapshot) {
    stopTimer();
    const ft = featureType();
    const byId = new Map(targetsByType[ft].map((t) => [t.id, t]));
    // Reveal the ones not found (no labels here — avoids clutter on a full board).
    for (const id of snap.remainingIds) {
      if (ft === "regions" || ft === "features") {
        const t = byId.get(id);
        if (t) addAreaOrLine(t, "revealed");
      } else {
        setState(id, "revealed");
      }
    }
    showEndScreen(snap);
  }

  // Build a Mode from the current state of the builder form.
  function buildModeFromForm(panel: HTMLElement): Mode {
    const val = (id: string) => (panel.querySelector(id) as HTMLSelectElement | HTMLInputElement).value;
    const checked = (id: string) => (panel.querySelector(id) as HTMLInputElement).checked;
    const ft = builderTab;
    const ordering = val("#f-order") as Ordering;
    const region = val("#f-region");
    const mistakes = val("#f-mistakes");
    const time = val("#f-time");
    const skip = checked("#f-skip") && ordering !== "free";
    // Region value is "all", "un:<continent>", or "sub:<subregion>".
    const regionFilter = region.startsWith("sub:")
      ? { subregions: [region.slice(4)] }
      : region.startsWith("un:")
        ? { regionUN: region.slice(3) }
        : undefined;
    const label = { countries: "Countries", cities: "Cities", regions: "Regions", features: "Features", subdivisions: "Subdivisions" }[ft];
    const mode: Mode = {
      id: "custom",
      label,
      description: "",
      featureType: ft,
      ordering,
      allowSkip: skip,
      allowReturn: skip,
      maxMistakes: mistakes === "" ? null : Number(mistakes),
      // polygon types hit by polygon (0); cities by 50 km; regions/features by their own per-target radiusKm.
      acceptRadiusKm: ft === "cities" ? 50 : ft === "regions" ? 200 : ft === "features" ? 100 : 0,
      forgivenessRadiusKm: Number(val("#f-forgive")),
      timerSeconds: time === "" ? null : Number(time),
      regionFilter,
    };
    if (ft === "countries") mode.includeUnrecognized = checked("#f-unrecognized");
    if (ft === "cities") mode.cityFilter = { capitalsOnly: checked("#f-capitals"), minPop: Number(val("#f-minpop")) };
    if (ft === "features") mode.featureFilter = { category: val("#f-category") || undefined };
    if (ft === "subdivisions") mode.subdivisionCountry = val("#f-country");
    return mode;
  }

  function showMenu() {
    stopTimer();
    engine = null;
    clearStates();
    document.body.className = "menu";
    const regionOpts = [
      '<option value="all">All regions</option>',
      ...REGIONS.map((r) => {
        const subs = [...(subByRegion.get(r) ?? [])].sort();
        const subOpts = subs.map((s) => `<option value="sub:${s}">&nbsp;&nbsp;${s}</option>`).join("");
        return `<optgroup label="${r}"><option value="un:${r}">All ${r}</option>${subOpts}</optgroup>`;
      }),
    ].join("");
    const popOpts = [1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000]
      .filter((p) => p >= cityMinPop)
      .map((p) => `<option value="${p}">${p / 1_000_000}M+</option>`)
      .join("");
    const plural = (c: string) => c[0].toUpperCase() + c.slice(1) + (/(o|ch|sh|s|x|z)$/.test(c) ? "es" : "s");
    const categoryOpts = ['<option value="">All categories</option>', ...FEATURE_CATEGORIES.map((c) => `<option value="${c}">${plural(c)}</option>`)].join("");
    const countryOpts = admin1Index.map((c) => `<option value="${c.adm0a3}">${c.country} (${c.count})</option>`).join("");
    els.overlay.innerHTML = `
      <div class="panel builder tab-${builderTab}">
        <h1>New game</h1>
        <div class="tabs">
          <button class="tab" data-tab="countries" type="button">Countries</button>
          <button class="tab" data-tab="cities" type="button">Cities</button>
          <button class="tab" data-tab="regions" type="button">Regions</button>
          <button class="tab" data-tab="features" type="button">Features</button>
          <button class="tab" data-tab="subdivisions" type="button">Subdivisions</button>
        </div>
        <div class="fields">
          <label class="row region-row"><span>Region</span><select id="f-region">${regionOpts}</select></label>
          <label class="row subdivision-only"><span>Country</span><select id="f-country">${countryOpts}</select></label>
          <label class="row"><span>Order</span><select id="f-order">
            <option value="random">Random</option>
            <option value="sequential">Alphabetical</option>
            <option value="free">Free-for-all (any order)</option>
          </select></label>
          <label class="row country-only"><span>Include de-facto states</span><input type="checkbox" id="f-unrecognized"></label>
          <label class="row city-only"><span>Capitals only</span><input type="checkbox" id="f-capitals"></label>
          <label class="row city-only"><span>Min city population</span><select id="f-minpop">${popOpts}</select></label>
          <label class="row feature-only"><span>Category</span><select id="f-category">${categoryOpts}</select></label>
          <label class="row"><span>Mistakes allowed</span><select id="f-mistakes">
            <option value="">Unlimited</option>
            <option value="0">0 — sudden death</option>
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
          </select></label>
          <label class="row"><span>Time limit</span><select id="f-time">
            <option value="">None</option>
            <option value="60">1:00</option>
            <option value="120">2:00</option>
            <option value="300">5:00</option>
            <option value="600">10:00</option>
          </select></label>
          <label class="row"><span>Wrong-click forgiveness</span><select id="f-forgive">
            <option value="0">Strict — exact only</option>
            <option value="500" selected>Normal — nearby is free</option>
            <option value="1500">Lenient — only way-off counts</option>
          </select></label>
          <label class="row"><span>Allow skip &amp; return</span><input type="checkbox" id="f-skip" checked></label>
          <label class="row"><span>Show borders</span><input type="checkbox" id="f-borders" checked></label>
        </div>
        <div id="builder-note" class="note"></div>
        <div class="end-actions"><button class="btn" id="start" type="button">Start game</button></div>
      </div>`;

    const panel = els.overlay.querySelector(".panel") as HTMLElement;
    const order = panel.querySelector("#f-order") as HTMLSelectElement;
    const skip = panel.querySelector("#f-skip") as HTMLInputElement;
    const capitals = panel.querySelector("#f-capitals") as HTMLInputElement;
    const minpop = panel.querySelector("#f-minpop") as HTMLSelectElement;
    const note = panel.querySelector("#builder-note") as HTMLElement;
    const syncEnabled = () => {
      skip.disabled = order.value === "free";
      minpop.disabled = capitals.checked;
    };
    panel.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === builderTab);
      b.onclick = () => {
        builderTab = b.dataset.tab as Mode["featureType"];
        panel.className = `panel builder tab-${builderTab}`;
        panel.querySelectorAll<HTMLButtonElement>(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === builderTab));
      };
    });
    order.onchange = syncEnabled;
    capitals.onchange = syncEnabled;
    syncEnabled();

    (panel.querySelector("#start") as HTMLButtonElement).onclick = () => {
      const mode = buildModeFromForm(panel);
      // Subdivisions load their pool on demand; the picker only lists non-empty countries.
      if (mode.featureType !== "subdivisions") {
        const pool = buildPool(targetsByType[mode.featureType], mode, drawnByType[mode.featureType]);
        if (!pool.length) {
          note.textContent = "No places match those options — widen the region or lower the population.";
          return;
        }
      }
      setBorders((panel.querySelector("#f-borders") as HTMLInputElement).checked);
      void startGame(mode);
    };
  }

  function showEndScreen(snap: GameSnapshot) {
    document.body.className = "menu";
    const won = snap.phase === "won";
    const lostToMistakes = !won && snap.maxMistakes != null && snap.mistakes > snap.maxMistakes;
    const title = won
      ? `<span class="won">Complete!</span>`
      : lostToMistakes
        ? `<span class="lost">Game over</span>`
        : `Round complete`;
    els.overlay.innerHTML =
      `<div class="panel"><h1>${title}</h1>` +
      `<div class="end-stats">Found <b>${snap.foundCount} / ${snap.total}</b>` +
      `${snap.revealedCount > 0 ? `<br>Passed: <b>${snap.revealedCount}</b>` : ""}<br>` +
      `Mistakes: <b>${snap.mistakes}${snap.maxMistakes != null ? ` / ${snap.maxMistakes}` : ""}</b></div>` +
      `<div class="end-actions"><button class="btn" id="again">Play again</button>` +
      `<button class="btn secondary" id="tomenu">New game</button></div></div>`;
    const mode = engine!.mode;
    (els.overlay.querySelector("#again") as HTMLButtonElement).onclick = () => startGame(mode);
    (els.overlay.querySelector("#tomenu") as HTMLButtonElement).onclick = () => showMenu();
  }

  // Load a country's subdivisions on demand: set the render source, build the pool,
  // and frame the country. Returns the target list (empty if the load fails).
  async function loadSubdivisions(adm0a3: string): Promise<Target[]> {
    const fc = await loadJSON<GeoJSON.FeatureCollection>(`${BASE}data/admin1/${adm0a3}.json`).catch(() => null);
    if (!fc) return [];
    (map.getSource("admin1") as maplibregl.GeoJSONSource).setData(fc);
    const targets: Target[] = fc.features.map((f) => {
      const p = f.properties as { id: string; name: string; lng: number; lat: number };
      return {
        id: p.id,
        name: p.name,
        centroid: [p.lng, p.lat],
        regions: { continent: "", subregion: "", regionUN: "" },
        status: { inDefaultQuiz: true },
        kind: "feature",
      };
    });
    // Frame the country from its subdivision label points.
    const lngs = targets.map((t) => t.centroid[0]);
    const lats = targets.map((t) => t.centroid[1]);
    if (lngs.length) {
      map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], {
        padding: 80,
        duration: 600,
      });
    }
    return targets;
  }

  async function startGame(mode: Mode) {
    clearStates();
    const pool =
      mode.featureType === "subdivisions"
        ? await loadSubdivisions(mode.subdivisionCountry ?? "")
        : buildPool(targetsByType[mode.featureType], mode, drawnByType[mode.featureType]);
    if (!pool.length) return;
    engine = new GameEngine(mode, pool);
    document.body.className = "in-game";
    els.skip.hidden = !(mode.allowSkip && mode.ordering !== "free");
    els.pass.hidden = mode.ordering === "free"; // pass reveals the current prompt
    if (mode.timerSeconds != null) {
      timer = setInterval(() => {
        engine!.tick();
        const s = engine!.snapshot();
        renderHud(s);
        if (s.phase !== "playing") finish(s);
      }, 250);
    }
    renderHud(engine.snapshot());
  }

  // --- input ---------------------------------------------------------------
  map.on("click", (e) => {
    if (!engine || engine.snapshot().phase !== "playing") return;
    const idAt = (layer: string) => {
      const f = map.queryRenderedFeatures(e.point, { layers: [layer] })[0];
      return ((f?.id as string | undefined) ?? f?.properties?.id ?? null) as string | null;
    };
    // Country under the cursor → land detection (ocean clicks never penalize).
    const countryUnder = idAt("country-fill");
    const onLand = countryUnder != null;
    // The polygon used for matching: subdivision in subdivisions mode, else the country.
    const clickedId = engine.mode.featureType === "subdivisions" ? idAt("admin1-fill") : countryUnder;
    const outcome = engine.guess(clickedId, e.lngLat.lng, e.lngLat.lat, onLand);
    applyOutcome(outcome);
    if (outcome.kind === "wrong") flashWrongMark(e.lngLat); // red X at the click
    const snap = engine.snapshot();
    renderHud(snap);
    if (snap.phase !== "playing") finish(snap);
  });

  els.skip.onclick = () => {
    if (!engine || !engine.skip()) return;
    const snap = engine.snapshot();
    renderHud(snap);
    if (snap.phase !== "playing") finish(snap);
  };
  els.pass.onclick = () => pass();
  els.quit.onclick = () => showMenu();

  els.toggleBasemap.onclick = () => applyBasemap(BASEMAPS[(BASEMAPS.indexOf(basemap) + 1) % BASEMAPS.length]);

  let isGlobe = true; // matches the style's default projection
  els.toggleProjection.onclick = () => {
    isGlobe = !isGlobe;
    map.setProjection({ type: isGlobe ? "globe" : "mercator" });
    els.toggleProjection.textContent = isGlobe ? "🗺 2D map" : "🌐 Globe";
  };
  let bordersOn = true;
  function setBorders(on: boolean) {
    bordersOn = on;
    setVis("country-line", on);
    els.toggleBorders.textContent = `Borders: ${on ? "on" : "off"}`;
  }
  els.toggleBorders.onclick = () => setBorders(!bordersOn);

  (window as unknown as { __startGame: (m: Mode) => void }).__startGame = startGame; // dev/test
  (window as unknown as { __engine: () => GameEngine | null }).__engine = () => engine; // dev/test

  map.on("load", () => {
    (map.getSource("cities") as maplibregl.GeoJSONSource).setData(cityFC);
    applyBasemap("satellite");
    showMenu();
  });
}

main().catch((err) => {
  document.getElementById("prompt")!.textContent = `Error: ${err.message}`;
  console.error(err);
});
