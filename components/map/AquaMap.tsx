"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as GLMap, MapLayerMouseEvent, Marker, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { AnimatePresence, motion } from "framer-motion";

import type { AnalysisRun, Candidate, LngLat, ScoreBreakdown, TownRef } from "@/lib/types";
import type { ConceptualLayout } from "@/lib/geospatial/layout";
import { WEIGHTS, WEIGHT_LABELS } from "@/lib/config/coefficients";
import { stageReached, type LayerId, type MapStage } from "./layers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Keyless satellite basemap.
 *
 * Esri World Imagery supplies the satellite raster and CARTO supplies dark
 * place labels; neither needs an API key, so the demo runs anywhere. Glyphs
 * come from the MapLibre demo font stack, which is why symbol layers below
 * use "Noto Sans Regular" rather than a Mapbox-hosted font.
 */
/** Served from public/; see scripts/copy-maplibre-worker.mjs. */
const MAPLIBRE_WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";

const SATELLITE_ATTRIB =
  "Imagery &copy; Esri, Maxar, Earthstar Geographics | Basemap &copy; OpenStreetMap contributors, &copy; CARTO";

const BASE_ATTRIB =
  "&copy; OpenStreetMap contributors, &copy; CARTO";

const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  projection: { type: "globe" },
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    "sat-raster": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: SATELLITE_ATTRIB,
    },
    /* Both grounds are in the style from the start, and the theme switches
       which one is VISIBLE. Repointing one source's tile URLs instead looked
       obvious and is not: already-loaded tiles stay in the cache until they
       happen to be re-requested, so a theme switch left the map half dark and
       half light until it was panned. Two layers and a visibility flag cost one
       extra source and swap instantly. */
    "base-light": {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: BASE_ATTRIB,
    },
    "base-dark": {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: BASE_ATTRIB,
    },
    /* Labels alone, re-drawn over imagery so place names survive it. */
    "labels-light": {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}@2x.png"],
      tileSize: 256,
      maxzoom: 19,
    },
    "labels-dark": {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png"],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#fbfbfc" } },
    { id: "base-light", type: "raster", source: "base-light", paint: { "raster-opacity": 1 } },
    {
      id: "base-dark",
      type: "raster",
      source: "base-dark",
      layout: { visibility: "none" },
      paint: { "raster-opacity": 1 },
    },
    /* Imagery is opt-in, so it ships hidden rather than transparent: the toggle
       switches visibility, and a layer that is both visible and at zero opacity
       is a second, invisible switch that disagrees with the first. */
    {
      id: "sat",
      type: "raster",
      source: "sat-raster",
      layout: { visibility: "none" },
      paint: { "raster-opacity": 1 },
    },
    {
      id: "labels-light",
      type: "raster",
      source: "labels-light",
      layout: { visibility: "none" },
      paint: { "raster-opacity": 0.9 },
    },
    {
      id: "labels-dark",
      type: "raster",
      source: "labels-dark",
      layout: { visibility: "none" },
      paint: { "raster-opacity": 0.9 },
    },
  ],
};

/* The accent means "this is the recommendation", and it is spent on the winner,
   the town outline and the conceptual design — nowhere else. The three ramp
   stops are the suitability SCALE, and the legend below reads from the same
   three so a colour on the map and a colour in the key cannot disagree. */
const ACCENT = "#2d72d2";

/* ---------- The basemap follows the theme ----------
   The map is a background, and a white ground inside a dark shell is the
   brightest thing on the screen — the one surface loud enough to undo the rest
   of the palette. So the ground, the atmosphere and the ink/halo pair all swap
   with the theme, and the marks drawn on top keep their meaning either way.

   `ink` is the colour of a label and `halo` is what separates it from the
   ground; they are a pair and always the inverse of each other, which is why
   they are declared together rather than as two independent constants. */
const BASEMAP = {
  light: {
    base: "light_all",
    labels: "light_only_labels",
    ground: "#fbfbfc",
    sky: "#e9edf2",
    horizon: "#123049",
    ink: "#101112",
    halo: "#ffffff",
  },
  dark: {
    base: "dark_all",
    labels: "dark_only_labels",
    ground: "#0e1013",
    sky: "#0a0b0d",
    horizon: "#0b1a2a",
    ink: "#f2f4f6",
    halo: "#0a0b0d",
  },
} as const;

type MapMode = keyof typeof BASEMAP;

/** The theme lives on <html>; "auto" defers to the OS. */
function resolveMode(): MapMode {
  if (typeof document === "undefined") return "light";
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return "dark";
  if (t === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const INK = BASEMAP.light.ink;
const HALO = BASEMAP.light.halo;
const SCORE_LOW = "#b42318";
const SCORE_MID = "#b54708";
const SCORE_HIGH = "#1a7f37";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const SOURCE = {
  candidates: "candidates",
  town: "aq-town",
  roads: "aq-roads",
  water: "aq-water",
  buildings: "aq-buildings",
  facilities: "aq-facilities",
  hazards: "aq-hazards",
  protectedAreas: "aq-protected",
  pipes: "aq-design-pipes",
  taps: "aq-design-taps",
  nodes: "aq-design-nodes",
  ring: "aq-design-ring",
} as const;

const LAYER = {
  townFill: "aq-town-fill",
  townLine: "aq-town-line",
  roads: "aq-roads-line",
  water: "aq-water-line",
  buildings: "aq-buildings-circle",
  facilities: "aq-facilities-circle",
  protectedFill: "aq-protected-fill",
  protectedLine: "aq-protected-line",
  hazards: "aq-hazards-circle",
  heatmap: "aq-candidates-heat",
  excluded: "aq-candidates-excluded",
  candidates: "aq-candidates-circle",
  top3: "aq-candidates-top3",
  top3Label: "aq-candidates-top3-label",
  ringFill: "aq-design-ring-fill",
  ringLine: "aq-design-ring-line",
  pipes: "aq-design-pipe-line",
  taps: "aq-design-tap-circle",
  nodes: "aq-design-node-circle",
  nodeLabels: "aq-design-node-label",
} as const;

/** Every layer whose paint depends on the ink/halo pair, and which property of
    it does. Listed once, so a theme swap cannot miss one and leave a dark label
    on a dark ground — the failure that is invisible until someone switches. */
const INK_LAYERS: {
  layer: string;
  prop: "text-color" | "text-halo-color" | "circle-stroke-color";
  key: "ink" | "halo";
}[] = [
  { layer: LAYER.facilities, prop: "circle-stroke-color", key: "halo" },
  { layer: LAYER.hazards, prop: "circle-stroke-color", key: "halo" },
  { layer: LAYER.excluded, prop: "circle-stroke-color", key: "halo" },
  { layer: LAYER.candidates, prop: "circle-stroke-color", key: "halo" },
  { layer: LAYER.top3Label, prop: "text-color", key: "ink" },
  { layer: LAYER.top3Label, prop: "text-halo-color", key: "halo" },
  { layer: LAYER.taps, prop: "circle-stroke-color", key: "halo" },
  { layer: LAYER.nodes, prop: "circle-stroke-color", key: "halo" },
  { layer: LAYER.nodeLabels, prop: "text-color", key: "ink" },
  { layer: LAYER.nodeLabels, prop: "text-halo-color", key: "halo" },
];

function show(map: GLMap, id: string, on: boolean): void {
  if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

/**
 * The ground, the atmosphere and every ink/halo pair, set from the theme and
 * the satellite toggle together.
 *
 * The two are one decision, not two: which label set is drawn depends on both
 * (labels only appear over imagery, and they have to match the theme), so
 * splitting this into a theme handler and a toggle handler is what lets the two
 * disagree.
 */
function applyBasemap(map: GLMap, mode: MapMode, satellite: boolean): void {
  const m = BASEMAP[mode];
  const dark = mode === "dark";

  show(map, "base-light", !dark);
  show(map, "base-dark", dark);
  show(map, "sat", satellite);
  show(map, "labels-light", satellite && !dark);
  show(map, "labels-dark", satellite && dark);

  if (map.getLayer("bg")) map.setPaintProperty("bg", "background-color", m.ground);
  applySky(map, mode);

  for (const { layer, prop, key } of INK_LAYERS) {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, m[key]);
  }
}

const CLICKABLE = [LAYER.candidates, LAYER.top3, LAYER.excluded];

const MAP_CSS = `
.aq-popup .maplibregl-popup-content{background:var(--bg-elevated);border:1px solid var(--border);border-radius:0;padding:11px 13px;box-shadow:var(--shadow-pop);color:var(--text);}
.aq-popup .maplibregl-popup-tip{border-top-color:var(--bg-elevated);border-bottom-color:var(--bg-elevated);border-left-color:var(--bg-elevated);border-right-color:var(--bg-elevated);}
.aq-popup .maplibregl-popup-close-button{color:var(--text-muted);font-size:15px;padding:2px 7px 0 0;background:transparent;}
.aq-popup .maplibregl-popup-close-button:hover{color:var(--text);background:transparent;}`;

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

type FactorKey = keyof ScoreBreakdown & keyof typeof WEIGHTS;

const FACTOR_KEYS: FactorKey[] = [
  "communityNeed",
  "populationAccessProxy",
  "groundwaterFeasibility",
  "roadAndConstructionAccess",
  "distanceFromExistingService",
  "environmentalSafety",
  "evidenceQuality",
];

/** Clamp a score to 0..1, tolerating a 0..100 upstream scale. */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return Math.min(1, value / 100);
  return Math.max(0, value);
}

function pct(value: number): number {
  return Math.round(unit(value) * 100);
}

/** Top factors by weighted contribution; name-sorted tie-break keeps it deterministic. */
function topFactors(breakdown: ScoreBreakdown, count: number): { key: FactorKey; value: number }[] {
  return FACTOR_KEYS.map((key) => ({ key, value: unit(breakdown[key]) }))
    .sort((a, b) => {
      const delta = b.value * WEIGHTS[b.key] - a.value * WEIGHTS[a.key];
      return delta !== 0 ? delta : a.key.localeCompare(b.key);
    })
    .slice(0, count);
}

// ---------------------------------------------------------------------------
// GeoJSON builders
// ---------------------------------------------------------------------------

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function finite(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90;
}

function pointFeature(
  lon: number,
  lat: number,
  properties: Record<string, string | number | boolean>,
): GeoJSON.Feature<GeoJSON.Point> {
  return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties };
}

function lineFeature(
  coords: LngLat[],
  properties: Record<string, string | number | boolean>,
): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties };
}

function polygonFeature(
  ring: LngLat[],
  properties: Record<string, string | number | boolean>,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const closed = ring.slice();
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) closed.push(first);
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [closed] }, properties };
}

function buildCandidates(run: AnalysisRun | null): GeoJSON.FeatureCollection {
  if (!run) return emptyCollection();
  const rankById = new Map<string, number>();
  run.ranked.forEach((id, index) => rankById.set(id, index + 1));
  const features = run.candidates
    .filter((candidate) => finite(candidate.lon, candidate.lat))
    .map((candidate) =>
      pointFeature(candidate.lon, candidate.lat, {
        id: candidate.id,
        score: unit(candidate.score.overall),
        excluded: candidate.excluded,
        rank: rankById.get(candidate.id) ?? 0,
        winner: run.winnerId === candidate.id,
      }),
    );
  return { type: "FeatureCollection", features };
}

function buildTown(town: TownRef | null): GeoJSON.FeatureCollection {
  if (!town) return emptyCollection();
  const [west, south, east, north] = town.bbox;
  if (![west, south, east, north].every((n) => Number.isFinite(n))) return emptyCollection();
  const ring: LngLat[] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
  return { type: "FeatureCollection", features: [polygonFeature(ring, { name: town.name })] };
}

type OsmCollections = {
  roads: GeoJSON.FeatureCollection;
  water: GeoJSON.FeatureCollection;
  buildings: GeoJSON.FeatureCollection;
  facilities: GeoJSON.FeatureCollection;
  hazards: GeoJSON.FeatureCollection;
  protectedAreas: GeoJSON.FeatureCollection;
};

function buildOsm(run: AnalysisRun | null): OsmCollections {
  if (!run) {
    return {
      roads: emptyCollection(),
      water: emptyCollection(),
      buildings: emptyCollection(),
      facilities: emptyCollection(),
      hazards: emptyCollection(),
      protectedAreas: emptyCollection(),
    };
  }
  const osm = run.osm;

  const lines = (input: { id: string; coords: LngLat[]; kind: string }[]): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: input
      .map((line) => line.coords.filter((coord) => finite(coord[0], coord[1])))
      .filter((coords) => coords.length >= 2)
      .map((coords, index) => lineFeature(coords, { index })),
  });

  const points = (
    input: { id: string; lon: number; lat: number; name?: string; kind: string }[],
    group: string,
  ): GeoJSON.Feature<GeoJSON.Point>[] =>
    input
      .filter((point) => finite(point.lon, point.lat))
      .map((point) => pointFeature(point.lon, point.lat, { group, kind: point.kind, name: point.name ?? "" }));

  return {
    roads: lines(osm.roads),
    water: lines(osm.waterways),
    buildings: { type: "FeatureCollection", features: points(osm.buildings, "building") },
    facilities: {
      type: "FeatureCollection",
      features: [
        ...points(osm.schools, "school"),
        ...points(osm.clinics, "clinic"),
        ...points(osm.waterPoints, "water"),
      ],
    },
    hazards: { type: "FeatureCollection", features: points(osm.hazards, "hazard") },
    protectedAreas: {
      type: "FeatureCollection",
      features: osm.protectedAreas
        .map((area) => area.ring.filter((coord) => finite(coord[0], coord[1])))
        .filter((ring) => ring.length >= 3)
        .map((ring, index) => polygonFeature(ring, { index })),
    },
  };
}

// ---------------------------------------------------------------------------
// Conceptual layout normalisation
//
// `ConceptualLayout` is authored in another module; this reader accepts the
// shapes a layout can plausibly take (tuples or {lon,lat} objects, explicit
// rings or centre+radius) so the overlay renders without assuming one encoding.
// ---------------------------------------------------------------------------

type LayoutNodeKind = "source" | "treatment" | "tank";
type LayoutNode = { lon: number; lat: number; kind: LayoutNodeKind; label: string };
type NormalizedLayout = { pipes: LngLat[][]; taps: LngLat[]; nodes: LayoutNode[]; ring: LngLat[] | null };

const EMPTY_LAYOUT: NormalizedLayout = { pipes: [], taps: [], nodes: [], ring: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function toPoint(value: unknown): LngLat | null {
  if (Array.isArray(value)) {
    const lon = num(value[0]);
    const lat = num(value[1]);
    return lon !== null && lat !== null && finite(lon, lat) ? [lon, lat] : null;
  }
  if (!isRecord(value)) return null;

  const lon = num(value.lon) ?? num(value.lng) ?? num(value.longitude) ?? num(value.x);
  const lat = num(value.lat) ?? num(value.latitude) ?? num(value.y);
  if (lon !== null && lat !== null && finite(lon, lat)) return [lon, lat];

  for (const key of ["coordinates", "coord", "center", "centre", "position", "point", "location", "lngLat", "geometry"]) {
    const nested = value[key];
    if (nested !== undefined && nested !== null) {
      const point = toPoint(nested);
      if (point) return point;
    }
  }
  return null;
}

function toLine(value: unknown): LngLat[] | null {
  if (Array.isArray(value)) {
    const points = value.map(toPoint).filter((point): point is LngLat => point !== null);
    return points.length >= 2 ? points : null;
  }
  if (!isRecord(value)) return null;

  for (const key of ["coords", "coordinates", "path", "points", "line", "geometry", "route"]) {
    const nested = value[key];
    if (nested !== undefined && nested !== null) {
      const line = toLine(nested);
      if (line) return line;
    }
  }
  const from = toPoint(firstDefined(value, ["from", "start", "a", "origin"]));
  const to = toPoint(firstDefined(value, ["to", "end", "b", "target"]));
  return from && to ? [from, to] : null;
}

/** Deterministic geodesic-ish circle; no randomness, stable vertex order. */
function circleRing(center: LngLat, radiusM: number, steps = 96): LngLat[] {
  const [lon, lat] = center;
  const latRadians = (lat * Math.PI) / 180;
  const deltaLat = radiusM / 111_320;
  const deltaLon = radiusM / (111_320 * Math.max(0.05, Math.cos(latRadians)));
  const ring: LngLat[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    ring.push([lon + deltaLon * Math.cos(angle), lat + deltaLat * Math.sin(angle)]);
  }
  return ring;
}

function toRing(value: unknown): LngLat[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    const direct = value.map(toPoint).filter((point): point is LngLat => point !== null);
    if (direct.length >= 3) return direct;
    return value.length > 0 ? toRing(value[0]) : null;
  }
  if (!isRecord(value)) return null;

  for (const key of ["ring", "coordinates", "polygon", "outer", "points", "geometry"]) {
    const nested = value[key];
    if (nested !== undefined && nested !== null) {
      const ring = toRing(nested);
      if (ring) return ring;
    }
  }
  const center = toPoint(firstDefined(value, ["center", "centre", "origin", "at"])) ?? toPoint(value);
  const radius =
    num(firstDefined(value, ["radiusM", "radius", "serviceRadiusM", "radiusMeters", "meters"])) ?? null;
  if (center && radius !== null && radius > 0) return circleRing(center, radius);
  return null;
}

function nodeLabel(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const keys = ["label", "name", "title"];
  const direct = firstDefined(value, keys);
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  // GeoJSON features carry their label under `properties`.
  const properties = value.properties;
  if (isRecord(properties)) {
    const nested = firstDefined(properties, keys);
    if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
  }
  return fallback;
}

function normalizeLayout(layout: ConceptualLayout | null): NormalizedLayout {
  if (layout === null || layout === undefined) return EMPTY_LAYOUT;
  const raw = layout as unknown;
  if (!isRecord(raw)) return EMPTY_LAYOUT;

  const pipesRaw = firstDefined(raw, ["pipes", "pipeNetwork", "mains", "network"]);
  const pipes = Array.isArray(pipesRaw)
    ? pipesRaw.map(toLine).filter((line): line is LngLat[] => line !== null)
    : [];

  const tapsRaw = firstDefined(raw, ["taps", "tapStands", "tapPoints"]);
  const taps = Array.isArray(tapsRaw)
    ? tapsRaw.map(toPoint).filter((point): point is LngLat => point !== null)
    : [];

  const nodeSpecs: { kind: LayoutNodeKind; keys: string[]; fallback: string }[] = [
    { kind: "source", keys: ["source", "waterSource", "borehole"], fallback: "SOURCE" },
    { kind: "treatment", keys: ["treatment", "treatmentUnit", "filtration"], fallback: "TREATMENT" },
    { kind: "tank", keys: ["tank", "storageTank", "storage", "reservoir"], fallback: "TANK" },
  ];

  const nodes: LayoutNode[] = [];
  for (const spec of nodeSpecs) {
    const value = firstDefined(raw, spec.keys);
    const point = toPoint(value);
    if (!point) continue;
    nodes.push({ lon: point[0], lat: point[1], kind: spec.kind, label: nodeLabel(value, spec.fallback) });
  }

  const ring = toRing(firstDefined(raw, ["serviceRadiusRing", "serviceRing", "coverageRing", "serviceArea"]));

  return { pipes, taps, nodes, ring };
}

type DesignCollections = {
  pipes: GeoJSON.FeatureCollection;
  taps: GeoJSON.FeatureCollection;
  nodes: GeoJSON.FeatureCollection;
  ring: GeoJSON.FeatureCollection;
};

function buildDesign(layout: NormalizedLayout): DesignCollections {
  return {
    pipes: {
      type: "FeatureCollection",
      features: layout.pipes.map((coords, index) => lineFeature(coords, { index })),
    },
    taps: {
      type: "FeatureCollection",
      features: layout.taps.map((point, index) => pointFeature(point[0], point[1], { index })),
    },
    nodes: {
      type: "FeatureCollection",
      features: layout.nodes.map((node) =>
        pointFeature(node.lon, node.lat, { kind: node.kind, label: node.label }),
      ),
    },
    ring: {
      type: "FeatureCollection",
      features: layout.ring ? [polygonFeature(layout.ring, { kind: "service" })] : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Opacity choreography
// ---------------------------------------------------------------------------

type OpacityProp =
  | "fill-opacity"
  | "line-opacity"
  | "circle-opacity"
  | "circle-stroke-opacity"
  | "heatmap-opacity"
  | "text-opacity";

type GroupKey =
  | "town"
  | "roads"
  | "water"
  | "existing"
  | "environment"
  | "excluded"
  | "candidates"
  | "heat"
  | "top3"
  | "design";

const OPACITY_TABLE: { layer: string; group: GroupKey; props: { prop: OpacityProp; max: number }[] }[] = [
  { layer: LAYER.townFill, group: "town", props: [{ prop: "fill-opacity", max: 0.05 }] },
  { layer: LAYER.townLine, group: "town", props: [{ prop: "line-opacity", max: 0.6 }] },
  { layer: LAYER.roads, group: "roads", props: [{ prop: "line-opacity", max: 0.85 }] },
  { layer: LAYER.water, group: "water", props: [{ prop: "line-opacity", max: 0.9 }] },
  { layer: LAYER.buildings, group: "existing", props: [{ prop: "circle-opacity", max: 0.3 }] },
  {
    layer: LAYER.facilities,
    group: "existing",
    props: [
      { prop: "circle-opacity", max: 0.9 },
      { prop: "circle-stroke-opacity", max: 0.55 },
    ],
  },
  { layer: LAYER.protectedFill, group: "environment", props: [{ prop: "fill-opacity", max: 0.13 }] },
  { layer: LAYER.protectedLine, group: "environment", props: [{ prop: "line-opacity", max: 0.5 }] },
  {
    layer: LAYER.hazards,
    group: "environment",
    props: [
      { prop: "circle-opacity", max: 0.8 },
      { prop: "circle-stroke-opacity", max: 0.6 },
    ],
  },
  { layer: LAYER.heatmap, group: "heat", props: [{ prop: "heatmap-opacity", max: 0.88 }] },
  {
    layer: LAYER.excluded,
    group: "excluded",
    props: [
      { prop: "circle-opacity", max: 0.45 },
      { prop: "circle-stroke-opacity", max: 0.35 },
    ],
  },
  {
    layer: LAYER.candidates,
    group: "candidates",
    props: [
      { prop: "circle-opacity", max: 0.92 },
      { prop: "circle-stroke-opacity", max: 0.85 },
    ],
  },
  { layer: LAYER.top3, group: "top3", props: [{ prop: "circle-stroke-opacity", max: 0.95 }] },
  { layer: LAYER.top3Label, group: "top3", props: [{ prop: "text-opacity", max: 1 }] },
  { layer: LAYER.ringFill, group: "design", props: [{ prop: "fill-opacity", max: 0.1 }] },
  { layer: LAYER.ringLine, group: "design", props: [{ prop: "line-opacity", max: 0.5 }] },
  { layer: LAYER.pipes, group: "design", props: [{ prop: "line-opacity", max: 0.95 }] },
  {
    layer: LAYER.taps,
    group: "design",
    props: [
      { prop: "circle-opacity", max: 0.9 },
      { prop: "circle-stroke-opacity", max: 0.8 },
    ],
  },
  {
    layer: LAYER.nodes,
    group: "design",
    props: [
      { prop: "circle-opacity", max: 0.95 },
      { prop: "circle-stroke-opacity", max: 0.9 },
    ],
  },
  { layer: LAYER.nodeLabels, group: "design", props: [{ prop: "text-opacity", max: 1 }] },
];

function groupAlpha(stage: MapStage, layers: Record<LayerId, boolean>): Record<GroupKey, number> {
  const gate = (reached: boolean, enabled: boolean): number => (reached && enabled ? 1 : 0);
  const suitability = stageReached(stage, "candidates") && layers.suitability;
  const heatMoment = stage === "heatmap";

  // Points recede while the heatmap reads and again once the winner takes over,
  // but they never disappear — the field stays legible behind the conclusion.
  let candidates = 0;
  if (suitability) {
    if (heatMoment) candidates = 0.28;
    else if (stageReached(stage, "winner")) candidates = 0.5;
    else candidates = 1;
  }

  return {
    town: stageReached(stage, "town") ? 1 : 0,
    roads: gate(stageReached(stage, "context"), layers.roads),
    water: gate(stageReached(stage, "context"), layers.water),
    existing: gate(stageReached(stage, "facilities"), layers.existing),
    environment: gate(stageReached(stage, "constraints"), layers.environment),
    excluded: suitability && !stageReached(stage, "eliminated") ? 1 : 0,
    candidates,
    heat: suitability && heatMoment ? 1 : 0,
    top3: gate(stageReached(stage, "top3"), layers.suitability),
    design: gate(stageReached(stage, "design"), layers.design),
  };
}

// ---------------------------------------------------------------------------
// Popup DOM
// ---------------------------------------------------------------------------

function metaLine(text: string): HTMLElement {
  const node = document.createElement("div");
  node.textContent = text;
  node.style.fontFamily = MONO;
  node.style.fontSize = "9.5px";
  node.style.letterSpacing = "0.14em";
  node.style.textTransform = "uppercase";
  node.style.color = "var(--text-muted)";
  return node;
}

function buildPopupNode(candidate: Candidate, rank: number): HTMLElement {
  const root = document.createElement("div");
  root.style.minWidth = "212px";
  root.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, sans-serif";

  root.appendChild(metaLine(rank > 0 ? `Rank ${rank} · ${candidate.id}` : candidate.id));

  const scoreRow = document.createElement("div");
  scoreRow.style.display = "flex";
  scoreRow.style.alignItems = "baseline";
  scoreRow.style.gap = "6px";
  scoreRow.style.margin = "6px 0 10px";

  const overall = document.createElement("span");
  overall.textContent = String(pct(candidate.score.overall));
  overall.style.fontSize = "30px";
  overall.style.lineHeight = "1";
  overall.style.fontWeight = "500";
  overall.style.letterSpacing = "-0.02em";
  overall.style.color = candidate.excluded ? "var(--text-muted)" : "var(--text)";
  scoreRow.appendChild(overall);

  const suffix = document.createElement("span");
  suffix.textContent = "/100 suitability";
  suffix.style.fontFamily = MONO;
  suffix.style.fontSize = "9.5px";
  suffix.style.letterSpacing = "0.12em";
  suffix.style.textTransform = "uppercase";
  suffix.style.color = "var(--text-muted)";
  scoreRow.appendChild(suffix);
  root.appendChild(scoreRow);

  for (const factor of topFactors(candidate.score.breakdown, 3)) {
    const row = document.createElement("div");
    row.style.marginBottom = "7px";

    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.justifyContent = "space-between";
    head.style.gap = "10px";
    head.style.marginBottom = "3px";

    const name = document.createElement("span");
    name.textContent = WEIGHT_LABELS[factor.key];
    name.style.fontSize = "11.5px";
    name.style.color = "var(--text)";
    head.appendChild(name);

    const value = document.createElement("span");
    value.textContent = `${pct(factor.value)}`;
    value.style.fontFamily = MONO;
    value.style.fontSize = "11px";
    value.style.color = "var(--text-muted)";
    head.appendChild(value);
    row.appendChild(head);

    const track = document.createElement("div");
    track.style.height = "2px";
    track.style.borderRadius = "0";
    track.style.background = "var(--bg-sunken)";
    const fill = document.createElement("div");
    fill.style.height = "2px";
    fill.style.borderRadius = "0";
    fill.style.width = `${pct(factor.value)}%`;
    fill.style.background = "var(--text)";
    track.appendChild(fill);
    row.appendChild(track);

    root.appendChild(row);
  }

  if (candidate.excluded && candidate.score.exclusions.length > 0) {
    const excluded = document.createElement("div");
    excluded.textContent = `Excluded — ${candidate.score.exclusions.join("; ")}`;
    excluded.style.marginTop = "9px";
    excluded.style.paddingTop = "8px";
    excluded.style.borderTop = "1px solid var(--border-subtle)";
    excluded.style.fontSize = "11px";
    excluded.style.color = "var(--st-bad)";
    root.appendChild(excluded);
  }

  const coords = metaLine(`${candidate.lat.toFixed(5)}, ${candidate.lon.toFixed(5)}`);
  coords.style.marginTop = "9px";
  coords.style.paddingTop = "8px";
  coords.style.borderTop = "1px solid var(--border-subtle)";
  root.appendChild(coords);

  return root;
}

// ---------------------------------------------------------------------------
// Map plumbing
// ---------------------------------------------------------------------------

function setSourceData(map: GLMap, id: string, data: GeoJSON.FeatureCollection): void {
  const source = map.getSource<GeoJSONSource>(id);
  if (source && typeof source.setData === "function") source.setData(data);
}

function applySky(map: GLMap, mode: MapMode): void {
  const m = BASEMAP[mode];
  map.setSky({
    "sky-color": m.sky,
    "horizon-color": m.horizon,
    "fog-color": m.ground,
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.35,
    "fog-ground-blend": 0.08,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.9, 6, 0.35, 10, 0],
  });
}

function installStyle(map: GLMap): void {
  applySky(map, resolveMode());

  for (const id of Object.values(SOURCE)) {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: emptyCollection() });
  }

  const add = (layer: Parameters<GLMap["addLayer"]>[0]): void => {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  };

  add({
    id: LAYER.townFill,
    type: "fill",
    source: SOURCE.town,
    paint: { "fill-color": ACCENT, "fill-opacity": 0, "fill-opacity-transition": { duration: 600 } },
  });
  add({
    id: LAYER.townLine,
    type: "line",
    source: SOURCE.town,
    paint: {
      "line-color": ACCENT,
      "line-width": 1,
      "line-dasharray": [3, 2],
      "line-opacity": 0,
      "line-opacity-transition": { duration: 600 },
    },
  });

  add({
    id: LAYER.roads,
    type: "line",
    source: SOURCE.roads,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      /* Amber, not grey: the CARTO ground already draws its roads in grey, so a
         grey overlay sat on top of them and toggling it changed nothing visible. */
      "line-color": "#e0a030",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 1.8, 17, 3.6],
      "line-opacity": 0,
      "line-opacity-transition": { duration: 500 },
    },
  });
  add({
    id: LAYER.water,
    type: "line",
    source: SOURCE.water,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#17a8d6",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 2.6, 17, 5.5],
      "line-blur": 0.5,
      "line-opacity": 0,
      "line-opacity-transition": { duration: 500 },
    },
  });

  add({
    id: LAYER.buildings,
    type: "circle",
    source: SOURCE.buildings,
    paint: {
      "circle-color": "#6b7075",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 14, 1.4, 17, 3.2],
      "circle-opacity": 0,
      "circle-opacity-transition": { duration: 500 },
    },
  });
  add({
    id: LAYER.facilities,
    type: "circle",
    source: SOURCE.facilities,
    paint: {
      "circle-color": [
        "match",
        ["get", "group"],
        "school",
        "#a78bfa",
        "clinic",
        "#f472b6",
        "water",
        ACCENT,
        "#6b7075",
      ],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2, 14, 3.8, 17, 6.5],
      "circle-stroke-width": 1,
      "circle-stroke-color": HALO,
      "circle-opacity": 0,
      "circle-stroke-opacity": 0,
      "circle-opacity-transition": { duration: 500 },
      "circle-stroke-opacity-transition": { duration: 500 },
    },
  });

  add({
    id: LAYER.protectedFill,
    type: "fill",
    source: SOURCE.protectedAreas,
    paint: { "fill-color": "#22c55e", "fill-opacity": 0, "fill-opacity-transition": { duration: 500 } },
  });
  add({
    id: LAYER.protectedLine,
    type: "line",
    source: SOURCE.protectedAreas,
    paint: {
      "line-color": "#1a7f37",
      "line-width": 1,
      "line-opacity": 0,
      "line-opacity-transition": { duration: 500 },
    },
  });
  add({
    id: LAYER.hazards,
    type: "circle",
    source: SOURCE.hazards,
    paint: {
      "circle-color": "#f97316",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.4, 14, 4.4, 17, 7.5],
      "circle-stroke-width": 1,
      "circle-stroke-color": HALO,
      "circle-opacity": 0,
      "circle-stroke-opacity": 0,
      "circle-opacity-transition": { duration: 500 },
      "circle-stroke-opacity-transition": { duration: 500 },
    },
  });

  add({
    id: LAYER.heatmap,
    type: "heatmap",
    source: SOURCE.candidates,
    filter: ["==", ["get", "excluded"], false],
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["get", "score"], 0, 0, 1, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 9, 0.7, 15, 2.1],
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(5,7,13,0)",
        0.18,
        "rgba(239,68,68,0.35)",
        0.42,
        "rgba(245,158,11,0.55)",
        0.68,
        "rgba(56,189,248,0.68)",
        1,
        "rgba(34,197,94,0.92)",
      ],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 10, 13, 26, 17, 52],
      "heatmap-opacity": 0,
      "heatmap-opacity-transition": { duration: 500 },
    },
  });

  add({
    id: LAYER.excluded,
    type: "circle",
    source: SOURCE.candidates,
    filter: ["==", ["get", "excluded"], true],
    paint: {
      "circle-color": "#9aa0a6",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.6, 13, 3, 16, 5.4],
      "circle-stroke-width": 0.6,
      "circle-stroke-color": HALO,
      "circle-opacity": 0,
      "circle-stroke-opacity": 0,
      "circle-opacity-transition": { duration: 600 },
      "circle-stroke-opacity-transition": { duration: 600 },
    },
  });

  add({
    id: LAYER.candidates,
    type: "circle",
    source: SOURCE.candidates,
    filter: ["==", ["get", "excluded"], false],
    paint: {
      "circle-color": [
        "interpolate",
        ["linear"],
        ["get", "score"],
        0,
        SCORE_LOW,
        0.5,
        SCORE_MID,
        0.75,
        "#a3e635",
        1,
        SCORE_HIGH,
      ],
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        ["+", 1.8, ["*", 1.6, ["get", "score"]]],
        13,
        ["+", 3.2, ["*", 3.4, ["get", "score"]]],
        16,
        ["+", 5.4, ["*", 7, ["get", "score"]]],
      ],
      "circle-stroke-width": 0.8,
      "circle-stroke-color": HALO,
      "circle-opacity": 0,
      "circle-stroke-opacity": 0,
      "circle-opacity-transition": { duration: 500 },
      "circle-stroke-opacity-transition": { duration: 500 },
    },
  });

  const topFilter: Parameters<GLMap["setFilter"]>[1] = [
    "all",
    ["==", ["get", "excluded"], false],
    [">", ["get", "rank"], 0],
    ["<=", ["get", "rank"], 3],
  ];

  add({
    id: LAYER.top3,
    type: "circle",
    source: SOURCE.candidates,
    filter: topFilter,
    paint: {
      "circle-color": "rgba(0,0,0,0)",
      "circle-opacity": 0,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 7, 13, 12, 16, 20],
      "circle-stroke-width": 1.4,
      "circle-stroke-color": ACCENT,
      "circle-stroke-opacity": 0,
      "circle-stroke-opacity-transition": { duration: 500 },
    },
  });
  add({
    id: LAYER.top3Label,
    type: "symbol",
    source: SOURCE.candidates,
    filter: topFilter,
    layout: {
      "text-field": ["concat", "#", ["to-string", ["get", "rank"]]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, -1.6],
      "text-allow-overlap": true,
      "text-letter-spacing": 0.08,
    },
    paint: {
      "text-color": INK,
      "text-halo-color": HALO,
      "text-halo-width": 1.2,
      "text-opacity": 0,
      "text-opacity-transition": { duration: 400 },
    },
  });

  add({
    id: LAYER.ringFill,
    type: "fill",
    source: SOURCE.ring,
    paint: { "fill-color": ACCENT, "fill-opacity": 0, "fill-opacity-transition": { duration: 600 } },
  });
  add({
    id: LAYER.ringLine,
    type: "line",
    source: SOURCE.ring,
    paint: {
      "line-color": ACCENT,
      "line-width": 1,
      "line-opacity": 0,
      "line-opacity-transition": { duration: 600 },
    },
  });
  add({
    id: LAYER.pipes,
    type: "line",
    source: SOURCE.pipes,
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": ACCENT,
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 16, 2.4, 19, 4],
      "line-dasharray": [2, 1.6],
      "line-opacity": 0,
      "line-opacity-transition": { duration: 600 },
    },
  });
  add({
    id: LAYER.taps,
    type: "circle",
    source: SOURCE.taps,
    paint: {
      "circle-color": "#7dd3fc",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.4, 16, 4.2, 19, 7],
      "circle-stroke-width": 1,
      "circle-stroke-color": HALO,
      "circle-opacity": 0,
      "circle-stroke-opacity": 0,
      "circle-opacity-transition": { duration: 600 },
      "circle-stroke-opacity-transition": { duration: 600 },
    },
  });
  add({
    id: LAYER.nodes,
    type: "circle",
    source: SOURCE.nodes,
    paint: {
      "circle-color": [
        "match",
        ["get", "kind"],
        "source",
        "#22c55e",
        "treatment",
        "#a78bfa",
        "tank",
        ACCENT,
        INK,
      ],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 4.5, 16, 7.5, 19, 11],
      "circle-stroke-width": 1.6,
      "circle-stroke-color": HALO,
      "circle-opacity": 0,
      "circle-stroke-opacity": 0,
      "circle-opacity-transition": { duration: 600 },
      "circle-stroke-opacity-transition": { duration: 600 },
    },
  });
  add({
    id: LAYER.nodeLabels,
    type: "symbol",
    source: SOURCE.nodes,
    layout: {
      "text-field": ["upcase", ["get", "label"]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
      "text-letter-spacing": 0.14,
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": INK,
      "text-halo-color": HALO,
      "text-halo-width": 1.3,
      "text-opacity": 0,
      "text-opacity-transition": { duration: 500 },
    },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AquaMap(props: {
  town: TownRef | null;
  run: AnalysisRun | null;
  layout: ConceptualLayout | null;
  stage: MapStage;
  layers: Record<LayerId, boolean>;
  focusCandidateId: string | null;
  onMapReady?: () => void;
}): JSX.Element {
  const { town, run, layout, stage, layers, focusCandidateId, onMapReady } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const winnerElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<GLMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const onReadyRef = useRef<(() => void) | undefined>(onMapReady);
  const appliedRef = useRef<Record<string, number>>({});
  const flownTownRef = useRef<string | null>(null);
  const flownWinnerRef = useRef<string | null>(null);
  const fittedDesignRef = useRef<string | null>(null);

  const [styleReady, setStyleReady] = useState(false);
  const [mode, setMode] = useState<MapMode>("light");

  // The theme is an external system: an attribute on <html> that the layout's
  // bootstrap and the ThemeSwitch both write. Watch it rather than threading a
  // prop down, so the map follows a change made anywhere in the app.
  useEffect(() => {
    const sync = (): void => setMode(resolveMode());
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", sync);

    return () => {
      observer.disconnect();
      media.removeEventListener("change", sync);
    };
  }, []);

  // The ground: theme and imagery toggle, applied together. Gated on styleReady
  // because every call addresses a layer the style has to have added first.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    applyBasemap(map, mode, layers.satellite);
  }, [styleReady, mode, layers.satellite]);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    onReadyRef.current = onMapReady;
  }, [onMapReady]);

  // --- derived data ---------------------------------------------------------

  const candidateIndex = useMemo(() => {
    const index = new Map<string, { candidate: Candidate; rank: number }>();
    if (!run) return index;
    const rankById = new Map<string, number>();
    run.ranked.forEach((id, position) => rankById.set(id, position + 1));
    for (const candidate of run.candidates) {
      index.set(candidate.id, { candidate, rank: rankById.get(candidate.id) ?? 0 });
    }
    return index;
  }, [run]);

  const candidateIndexRef = useRef(candidateIndex);
  useEffect(() => {
    candidateIndexRef.current = candidateIndex;
  }, [candidateIndex]);

  const winner = useMemo(() => {
    if (!run || !run.winnerId) return null;
    return candidateIndex.get(run.winnerId)?.candidate ?? null;
  }, [run, candidateIndex]);

  const normalizedLayout = useMemo(() => normalizeLayout(layout), [layout]);
  const candidateData = useMemo(() => buildCandidates(run), [run]);
  const osmData = useMemo(() => buildOsm(run), [run]);
  const townData = useMemo(() => buildTown(town), [town]);
  const designData = useMemo(() => buildDesign(normalizedLayout), [normalizedLayout]);

  const hasDesign =
    normalizedLayout.pipes.length > 0 ||
    normalizedLayout.taps.length > 0 ||
    normalizedLayout.nodes.length > 0 ||
    normalizedLayout.ring !== null;

  // --- map lifecycle --------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // MapLibre locates its worker beside its own module URL, which the bundler
    // rewrites, so by default it spawns the worker from the page itself. Raster
    // tiles still draw (they load on the main thread) but every GeoJSON overlay
    // waits forever for a worker that never answers. The worker is copied into
    // public/ by scripts/copy-maplibre-worker.mjs.
    maplibregl.setWorkerUrl(MAPLIBRE_WORKER_URL);

    const map = new maplibregl.Map({
      container,
      style: BASE_STYLE,
      center: [-34, 16], // mid-Atlantic: the globe reads as a globe on first paint
      zoom: 1.6,
      pitch: 0,
      bearing: 0,
      attributionControl: { compact: true },
      cooperativeGestures: false,
    });
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __aquaMap?: GLMap }).__aquaMap = map;
    }
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

    const onStyleLoad = (): void => {
      installStyle(map);
      appliedRef.current = {};
      setStyleReady(true);
      onReadyRef.current?.();
    };
    const onError = (event: { error?: { message?: string; status?: number } }): void => {
      const status = event.error?.status;
      const message = event.error?.message ?? "";
      // Surface the cause rather than silently rendering an empty canvas.
      console.error("[AquaMap] map error:", status ?? "", message, event.error);
      if (status === 401 || status === 403 || /access token|unauthorized/i.test(message)) {
        setRuntimeError("Basemap tiles could not be loaded. Check the network connection; the analysis itself does not depend on them.");
      }
    };

    map.on("style.load", onStyleLoad);
    map.on("error", onError);

    // The container is sized by flex/absolute layout, so the initial GL canvas
    // can be measured before layout settles. Track it for the life of the map.
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      popupRef.current?.remove();
      popupRef.current = null;
      markerRef.current?.remove();
      markerRef.current = null;
      map.off("style.load", onStyleLoad);
      map.off("error", onError);
      mapRef.current = null;
      setStyleReady(false);
      map.remove();
    };
  }, []);

  // --- source data ----------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    setSourceData(map, SOURCE.candidates, candidateData);
    setSourceData(map, SOURCE.roads, osmData.roads);
    setSourceData(map, SOURCE.water, osmData.water);
    setSourceData(map, SOURCE.buildings, osmData.buildings);
    setSourceData(map, SOURCE.facilities, osmData.facilities);
    setSourceData(map, SOURCE.hazards, osmData.hazards);
    setSourceData(map, SOURCE.protectedAreas, osmData.protectedAreas);
  }, [styleReady, candidateData, osmData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    setSourceData(map, SOURCE.town, townData);
  }, [styleReady, townData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    setSourceData(map, SOURCE.pipes, designData.pipes);
    setSourceData(map, SOURCE.taps, designData.taps);
    setSourceData(map, SOURCE.nodes, designData.nodes);
    setSourceData(map, SOURCE.ring, designData.ring);
  }, [styleReady, designData]);

  // --- stage + toggle choreography -----------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;

    const alpha = groupAlpha(stage, layers);
    for (const entry of OPACITY_TABLE) {
      if (!map.getLayer(entry.layer)) continue;
      for (const { prop, max } of entry.props) {
        const value = Number((max * alpha[entry.group]).toFixed(3));
        const key = `${entry.layer}:${prop}`;
        if (appliedRef.current[key] === value) continue;
        appliedRef.current[key] = value;
        map.setPaintProperty(entry.layer, prop, value);
      }
    }

  }, [styleReady, stage, layers]);

  // --- cinematic camera: town ----------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !town) return;
    if (flownTownRef.current === town.slug) return;
    flownTownRef.current = town.slug;

    map.easeTo({ center: town.center, zoom: 4, pitch: 0, bearing: 0, duration: 1200, essential: true });
    const timer = window.setTimeout(() => {
      const current = mapRef.current;
      if (!current) return;
      current.flyTo({
        center: town.center,
        zoom: 13.2,
        pitch: 45,
        bearing: 0,
        curve: 1.5,
        speed: 0.7,
        essential: true,
      });
    }, 1250);

    return () => window.clearTimeout(timer);
  }, [styleReady, town]);

  // --- cinematic camera: winner --------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !winner) return;
    if (!stageReached(stage, "winner")) return;
    const key = `${town?.slug ?? ""}:${winner.id}`;
    if (flownWinnerRef.current === key) return;
    flownWinnerRef.current = key;

    map.flyTo({
      center: [winner.lon, winner.lat],
      zoom: 15.5,
      pitch: 52,
      curve: 1.4,
      speed: 0.6,
      essential: true,
    });
  }, [styleReady, stage, winner, town]);

  // --- cinematic camera: conceptual design ----------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    if (!stageReached(stage, "design") || !layers.design) return;
    const ring = normalizedLayout.ring;
    if (!ring || ring.length < 3) return;
    const key = `${town?.slug ?? ""}:${ring.length}:${ring[0][0]},${ring[0][1]}`;
    if (fittedDesignRef.current === key) return;
    fittedDesignRef.current = key;

    const bounds = new maplibregl.LngLatBounds(ring[0], ring[0]);
    for (const coord of ring) bounds.extend(coord);
    map.fitBounds(bounds, { padding: 96, duration: 1400, pitch: 40, essential: true });
  }, [styleReady, stage, layers.design, normalizedLayout, town]);

  // --- winner marker --------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    const element = winnerElRef.current;
    if (!map || !styleReady) return;

    if (!winner || !element || !stageReached(stage, "winner")) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const marker =
      markerRef.current ?? (markerRef.current = new maplibregl.Marker({ element, anchor: "center" }));
    marker.setLngLat([winner.lon, winner.lat]).addTo(map);
  }, [styleReady, stage, winner]);

  // --- interaction: click a candidate --------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;

    const openPopup = (candidate: Candidate, rank: number): void => {
      const popup =
        popupRef.current ??
        (popupRef.current = new maplibregl.Popup({
          className: "aq-popup",
          closeButton: true,
          closeOnClick: true,
          offset: 14,
          maxWidth: "280px",
        }));
      popup
        .setLngLat([candidate.lon, candidate.lat])
        .setDOMContent(buildPopupNode(candidate, rank))
        .addTo(map);
    };

    const onClick = (event: MapLayerMouseEvent): void => {
      const feature = event.features?.[0];
      if (!feature) return;
      const properties = (feature.properties ?? {}) as Record<string, unknown>;
      const id = typeof properties.id === "string" ? properties.id : null;
      if (!id) return;
      const entry = candidateIndexRef.current.get(id);
      if (!entry) return;
      openPopup(entry.candidate, entry.rank);
    };

    const onEnter = (): void => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = (): void => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", CLICKABLE, onClick);
    map.on("mouseenter", CLICKABLE, onEnter);
    map.on("mouseleave", CLICKABLE, onLeave);

    return () => {
      map.off("click", CLICKABLE, onClick);
      map.off("mouseenter", CLICKABLE, onEnter);
      map.off("mouseleave", CLICKABLE, onLeave);
    };
  }, [styleReady]);

  // --- external focus -------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !focusCandidateId) return;
    const entry = candidateIndex.get(focusCandidateId);
    if (!entry) return;

    const { candidate, rank } = entry;
    map.easeTo({
      center: [candidate.lon, candidate.lat],
      zoom: Math.max(map.getZoom(), 15),
      duration: 900,
      essential: true,
    });

    const focusPopup =
      popupRef.current ??
      (popupRef.current = new maplibregl.Popup({
        className: "aq-popup",
        closeButton: true,
        closeOnClick: true,
        offset: 14,
        maxWidth: "280px",
      }));
    focusPopup
      .setLngLat([candidate.lon, candidate.lat])
      .setDOMContent(buildPopupNode(candidate, rank))
      .addTo(map);
  }, [styleReady, focusCandidateId, candidateIndex]);

  // --- render ---------------------------------------------------------------

  const showLegend = stageReached(stage, "candidates") && layers.suitability;
  const showDesignPill = stageReached(stage, "design") && layers.design && hasDesign;

  return (
    <div className="aq-map relative h-full w-full overflow-hidden bg-[var(--bg-canvas)]">
      <style>{MAP_CSS}</style>

      <div ref={containerRef} className="absolute inset-0" />

      {/* Host for the single winner marker element; Mapbox moves it into the map. */}
      <div className="hidden" aria-hidden="true">
        <div ref={winnerElRef} className="relative h-[20px] w-[20px]">
          <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)] opacity-30" />
          <span className="absolute inset-[4px] rounded-full border-2 border-white bg-[var(--accent)] shadow-[var(--shadow-1)]" />
        </div>
      </div>

      <AnimatePresence>
        {showDesignPill && (
          <motion.div
            key="design-pill"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute left-4 top-4 z-10"
          >
            <span className="ch-pill live bg-[var(--bg-elevated)]">Conceptual layout</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showLegend && (
          <motion.div
            key="score-legend"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="card pointer-events-none absolute bottom-4 left-4 z-10 px-3 py-2.5 shadow-[var(--shadow-2)]"
          >
            <div className="lbl">Suitability</div>
            <div className="mt-2 h-[4px] w-[132px] bg-[linear-gradient(90deg,var(--score-low)_0%,var(--score-mid)_50%,var(--score-high)_100%)]" />
            <div className="lbl mt-1.5 flex w-[132px] justify-between">
              <span>0</span>
              <span>100</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {runtimeError && (
          <motion.div
            key="runtime-error"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.3 }}
            className="toast pointer-events-none absolute bottom-4 left-1/2 z-20 max-w-[440px] -translate-x-1/2"
          >
            {runtimeError}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
