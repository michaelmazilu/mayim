import type { LngLat, OsmData, OsmLine, OsmPoint, OsmPolygon, TownRef } from "@/lib/types";
import { EMPTY_OSM } from "@/lib/types";
import { fetchJson } from "@/lib/providers/fetchWithTimeout";

/**
 * OpenStreetMap layers via Overpass.
 *
 * The public instance allows only two concurrent slots per IP, so an analysis run
 * issues exactly ONE combined request — never one per layer — and falls back to a
 * mirror only after the primary endpoint has failed.
 */

const USER_AGENT = "AquaSite/1.0 (hackathon pre-feasibility demo)";
const TIMEOUT_MS = 25_000;

const ENDPOINTS = [
  { url: "https://overpass-api.de/api/interpreter", label: "overpass-api.de" },
  { url: "https://overpass.kumi.systems/api/interpreter", label: "overpass.kumi.systems" },
] as const;

/** Client-payload guards. Anything over the cap is deterministically subsampled. */
const CAP = {
  buildings: 4000,
  roads: 1500,
  waterways: 600,
  other: 400,
} as const;

/** Per-feature vertex guards — a single forest multipolygon can carry tens of thousands of nodes. */
const MAX_LINE_POINTS = 400;
const MAX_RING_POINTS = 500;

const HIGHWAY_RE = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track)$";
const WATERWAY_RE = "^(river|stream|canal)$";
const HEALTH_RE = "^(clinic|hospital|doctors)$";
const WATER_MANMADE_RE = "^(water_well|water_tower|water_works|borehole)$";
const HAZARD_LANDUSE_RE = "^(industrial|landfill|quarry)$";

const HIGHWAY_KINDS = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "track",
]);
const WATERWAY_KINDS = new Set(["river", "stream", "canal"]);
const HEALTH_KINDS = new Set(["clinic", "hospital", "doctors"]);
const WATER_MANMADE_KINDS = new Set(["water_well", "water_tower", "water_works", "borehole"]);
const HAZARD_LANDUSE_KINDS = new Set(["industrial", "landfill", "quarry"]);

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

function r6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function buildOverpassQuery(bbox: [number, number, number, number]): string {
  // TownRef.bbox is [west, south, east, north].
  // Overpass bounding boxes are (south, west, north, east) — a different order —
  // so the components are explicitly re-ordered here rather than passed through.
  const west = r6(bbox[0]);
  const south = r6(bbox[1]);
  const east = r6(bbox[2]);
  const north = r6(bbox[3]);
  const b = `(${south},${west},${north},${east})`;

  // Three groups, three output modes:
  //  .lines  -> `out geom` gives inline coordinates for roads/waterways in one pass
  //  .areas  -> `out geom` gives the polygon rings (relation members carry geometry too)
  //  .points -> `out center` collapses buildings/facilities to a single coordinate
  return [
    "[out:json][timeout:25];",
    "(",
    `  way["highway"~"${HIGHWAY_RE}"]${b};`,
    `  way["waterway"~"${WATERWAY_RE}"]${b};`,
    ")->.lines;",
    "(",
    `  way["boundary"="protected_area"]${b};`,
    `  relation["boundary"="protected_area"]${b};`,
    `  way["leisure"="nature_reserve"]${b};`,
    `  relation["leisure"="nature_reserve"]${b};`,
    `  way["landuse"="forest"]${b};`,
    `  relation["landuse"="forest"]${b};`,
    ")->.areas;",
    "(",
    `  way["building"]${b};`,
    `  relation["building"]${b};`,
    `  node["amenity"="school"]${b};`,
    `  way["amenity"="school"]${b};`,
    `  node["amenity"~"${HEALTH_RE}"]${b};`,
    `  way["amenity"~"${HEALTH_RE}"]${b};`,
    `  node["man_made"~"${WATER_MANMADE_RE}"]${b};`,
    `  way["man_made"~"${WATER_MANMADE_RE}"]${b};`,
    `  node["amenity"="drinking_water"]${b};`,
    `  way["amenity"="drinking_water"]${b};`,
    `  node["natural"="spring"]${b};`,
    `  way["natural"="spring"]${b};`,
    `  way["landuse"="reservoir"]${b};`,
    `  way["water"="reservoir"]${b};`,
    `  node["landuse"~"${HAZARD_LANDUSE_RE}"]${b};`,
    `  way["landuse"~"${HAZARD_LANDUSE_RE}"]${b};`,
    `  node["amenity"="waste_disposal"]${b};`,
    `  way["amenity"="waste_disposal"]${b};`,
    `  node["man_made"="wastewater_plant"]${b};`,
    `  way["man_made"="wastewater_plant"]${b};`,
    ")->.points;",
    ".lines out geom;",
    ".areas out geom;",
    ".points out center;",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

type OverpassCoord = { lat?: number; lon?: number };

type OverpassMember = {
  type?: string;
  role?: string;
  geometry?: OverpassCoord[];
};

type OverpassElement = {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: OverpassCoord;
  geometry?: OverpassCoord[];
  members?: OverpassMember[];
  tags?: Record<string, string>;
};

type OverpassResponse = { elements?: OverpassElement[] };

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function toLngLat(c: OverpassCoord): LngLat | null {
  if (typeof c.lon !== "number" || typeof c.lat !== "number") return null;
  if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) return null;
  return [r6(c.lon), r6(c.lat)];
}

/**
 * Deterministic even-spacing subsample: keeps exactly `max` items at fixed index
 * ratios. A fixed integer stride would overshoot badly — 1679 roads capped at
 * 1500 would collapse to 840 — so the ratio form is used instead.
 */
function decimate<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(items[Math.floor((i * items.length) / max)]);
  }
  return out;
}

function coordsOf(geometry: OverpassCoord[] | undefined): LngLat[] {
  if (!Array.isArray(geometry)) return [];
  const out: LngLat[] = [];
  for (const g of geometry) {
    const p = toLngLat(g);
    if (p) out.push(p);
  }
  return out;
}

function lineOf(el: OverpassElement): LngLat[] | null {
  const coords = coordsOf(el.geometry);
  return coords.length >= 2 ? decimate(coords, MAX_LINE_POINTS) : null;
}

function ringOf(el: OverpassElement): LngLat[] | null {
  let coords = coordsOf(el.geometry);
  if (coords.length < 3 && Array.isArray(el.members)) {
    // Relations return their members' geometry; the outer ring(s) define the area.
    const outer: LngLat[] = [];
    for (const m of el.members) {
      if (m.role !== "outer" && m.role !== "") continue;
      outer.push(...coordsOf(m.geometry));
    }
    coords = outer;
  }
  if (coords.length < 3) return null;
  const ring = decimate(coords, MAX_RING_POINTS);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function pointOf(el: OverpassElement): LngLat | null {
  const direct = toLngLat({ lat: el.lat, lon: el.lon });
  if (direct) return direct;
  if (el.center) return toLngLat(el.center);
  return null;
}

function idOf(el: OverpassElement): string {
  const prefix = typeof el.type === "string" && el.type.length > 0 ? el.type.charAt(0) : "x";
  return `${prefix}${typeof el.id === "number" ? el.id : 0}`;
}

type Sortable<T> = { key: number; value: T };

/** Sort by OSM id (stable across runs), then keep every Nth if over the cap. */
function capped<T>(items: Sortable<T>[], cap: number, label: string, notes: string[]): T[] {
  const sorted = [...items].sort((a, b) => a.key - b.key);
  if (sorted.length <= cap) return sorted.map((i) => i.value);
  const kept = decimate(sorted, cap);
  notes.push(`${label} subsampled to ${kept.length} of ${sorted.length}`);
  return kept.map((i) => i.value);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function waterPointKind(tags: Record<string, string>): string | null {
  const manMade = tags["man_made"];
  if (manMade && WATER_MANMADE_KINDS.has(manMade)) return manMade;
  if (tags["amenity"] === "drinking_water") return "drinking_water";
  if (tags["natural"] === "spring") return "spring";
  if (tags["landuse"] === "reservoir" || tags["water"] === "reservoir") return "reservoir";
  return null;
}

function hazardKind(tags: Record<string, string>): string | null {
  const landuse = tags["landuse"];
  if (landuse && HAZARD_LANDUSE_KINDS.has(landuse)) return landuse;
  if (tags["amenity"] === "waste_disposal") return "waste_disposal";
  if (tags["man_made"] === "wastewater_plant") return "wastewater_plant";
  return null;
}

function protectedKind(tags: Record<string, string>): string | null {
  if (tags["boundary"] === "protected_area") return "protected_area";
  if (tags["leisure"] === "nature_reserve") return "nature_reserve";
  if (tags["landuse"] === "forest") return "forest";
  return null;
}

function parseElements(elements: OverpassElement[], sourceLabel: string): OsmData {
  const roads: Sortable<OsmLine>[] = [];
  const waterways: Sortable<OsmLine>[] = [];
  const buildings: Sortable<OsmPoint>[] = [];
  const schools: Sortable<OsmPoint>[] = [];
  const clinics: Sortable<OsmPoint>[] = [];
  const waterPoints: Sortable<OsmPoint>[] = [];
  const hazards: Sortable<OsmPoint>[] = [];
  const protectedAreas: Sortable<OsmPolygon>[] = [];

  // A single element can be emitted by more than one `out` statement (e.g. a way
  // that is both a building and a nature reserve). First classification wins, and
  // the geometry-bearing outputs are emitted first, so geometry is never lost.
  const seen = new Set<string>();

  for (const el of elements) {
    const id = idOf(el);
    if (seen.has(id)) continue;
    const tags = el.tags ?? {};
    const name = typeof tags["name"] === "string" ? tags["name"] : undefined;
    const key = typeof el.id === "number" ? el.id : 0;

    const highway = tags["highway"];
    if (highway && HIGHWAY_KINDS.has(highway)) {
      const coords = lineOf(el);
      if (coords) {
        roads.push({ key, value: { id, coords, name, kind: highway } });
        seen.add(id);
      }
      continue;
    }

    const waterway = tags["waterway"];
    if (waterway && WATERWAY_KINDS.has(waterway)) {
      const coords = lineOf(el);
      if (coords) {
        waterways.push({ key, value: { id, coords, name, kind: waterway } });
        seen.add(id);
      }
      continue;
    }

    const protectedTag = protectedKind(tags);
    if (protectedTag) {
      const ring = ringOf(el);
      if (ring) {
        protectedAreas.push({ key, value: { id, ring, name, kind: protectedTag } });
        seen.add(id);
      }
      continue;
    }

    const point = pointOf(el);
    if (!point) continue;
    const [lon, lat] = point;

    if (tags["amenity"] === "school") {
      schools.push({ key, value: { id, lon, lat, name, kind: "school" } });
      seen.add(id);
      continue;
    }

    const amenity = tags["amenity"];
    if (amenity && HEALTH_KINDS.has(amenity)) {
      clinics.push({ key, value: { id, lon, lat, name, kind: amenity } });
      seen.add(id);
      continue;
    }

    const water = waterPointKind(tags);
    if (water) {
      waterPoints.push({ key, value: { id, lon, lat, name, kind: water } });
      seen.add(id);
      continue;
    }

    const hazard = hazardKind(tags);
    if (hazard) {
      hazards.push({ key, value: { id, lon, lat, name, kind: hazard } });
      seen.add(id);
      continue;
    }

    if (tags["building"]) {
      buildings.push({ key, value: { id, lon, lat, name, kind: "building" } });
      seen.add(id);
    }
  }

  const notes: string[] = [];
  const keptBuildings = Math.min(buildings.length, CAP.buildings);
  const data: OsmData = {
    roads: capped(roads, CAP.roads, "roads", notes),
    waterways: capped(waterways, CAP.waterways, "waterways", notes),
    buildings: capped(buildings, CAP.buildings, "buildings", notes),
    schools: capped(schools, CAP.other, "schools", notes),
    clinics: capped(clinics, CAP.other, "clinics", notes),
    waterPoints: capped(waterPoints, CAP.other, "water points", notes),
    hazards: capped(hazards, CAP.other, "hazard sites", notes),
    protectedAreas: capped(protectedAreas, CAP.other, "protected areas", notes),
    buildingSampleRatio: keptBuildings > 0 ? buildings.length / keptBuildings : 1,
    degraded: false,
  };

  const total =
    data.roads.length +
    data.waterways.length +
    data.buildings.length +
    data.schools.length +
    data.clinics.length +
    data.waterPoints.length +
    data.hazards.length +
    data.protectedAreas.length;

  if (total === 0) {
    return {
      ...data,
      degraded: true,
      note: `OpenStreetMap returned no mapped features for this area (via ${sourceLabel})`,
    };
  }

  const head = `OpenStreetMap via ${sourceLabel}`;
  data.note = notes.length > 0 ? `${head}; ${notes.join("; ")}` : head;
  return data;
}

function degradedOsm(note: string): OsmData {
  // Fresh arrays: EMPTY_OSM is a shared module-level constant and must not be aliased.
  return {
    ...EMPTY_OSM,
    roads: [],
    waterways: [],
    buildings: [],
    schools: [],
    clinics: [],
    waterPoints: [],
    hazards: [],
    protectedAreas: [],
    degraded: true,
    note,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchOsm(town: TownRef): Promise<OsmData> {
  try {
    const body = `data=${encodeURIComponent(buildOverpassQuery(town.bbox))}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body,
      cache: "no-store",
    };

    for (const endpoint of ENDPOINTS) {
      const json = await fetchJson<OverpassResponse>(endpoint.url, init, TIMEOUT_MS);
      if (json && Array.isArray(json.elements)) {
        return parseElements(json.elements, endpoint.label);
      }
    }

    return degradedOsm(
      "OpenStreetMap unavailable: Overpass did not respond on either the primary endpoint or the mirror. Map layers are omitted from this run.",
    );
  } catch {
    return degradedOsm(
      "OpenStreetMap unavailable: the Overpass response could not be read. Map layers are omitted from this run.",
    );
  }
}
