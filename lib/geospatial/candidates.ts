/**
 * Deterministic candidate-site grid generation.
 *
 * A hex-ish lattice is laid over the town bounding box and clipped to a circular
 * analysis radius around the town centre. The cell size is auto-selected so the
 * resulting point count lands inside the 150-500 band regardless of how large the
 * bbox is. Nothing here is random: the same TownRef always produces byte-identical
 * points and ids.
 */

import { distance } from "@turf/turf";
import type { LngLat, TownRef } from "@/lib/types";

export type CandidatePoint = { id: string; lon: number; lat: number };

/** Target band for the generated point count. */
const MIN_POINTS = 150;
const MAX_POINTS = 500;
const IDEAL_POINTS = 320;

/** Bounds on the auto-selected cell size, metres. */
const MIN_CELL_M = 25;
const MAX_CELL_M = 2500;

/** Bounds on the derived analysis radius, metres. */
const MIN_RADIUS_M = 1500;
const MAX_RADIUS_M = 12000;

/** Row spacing of a hex lattice as a fraction of the cell size; odd rows are offset half a cell. */
const HEX_ROW_FACTOR = Math.sqrt(3) / 2;

/** Multiplicative step used while searching for a cell size that lands in the band. */
const CELL_SEARCH_STEP = 1.12;
const CELL_SEARCH_ITERATIONS = 40;

/** Hard ceiling so a pathological bbox can never allocate an unbounded lattice. */
const MAX_LATTICE_POINTS = 40000;

/** Latitude limit used when probing degree-to-metre scale, to stay off the poles. */
const MAX_PROBE_LAT = 89.5;

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Town centre, falling back to the bbox midpoint and finally to the null island. */
function centreOf(town: TownRef): LngLat {
  const [lon, lat] = town.center;
  if (Number.isFinite(lon) && Number.isFinite(lat)) {
    return [lon, clamp(lat, -MAX_PROBE_LAT, MAX_PROBE_LAT)];
  }
  const [w, s, e, n] = town.bbox;
  const midLon = (w + e) / 2;
  const midLat = (s + n) / 2;
  if (Number.isFinite(midLon) && Number.isFinite(midLat)) {
    return [midLon, clamp(midLat, -MAX_PROBE_LAT, MAX_PROBE_LAT)];
  }
  return [0, 0];
}

/** Metres per degree of latitude / longitude at a centre, measured with turf's geodesy. */
function metresPerDegree(centre: LngLat): { lat: number; lon: number } {
  const [lon, lat] = centre;
  const d = 0.01;
  const perLat = distance([lon, lat], [lon, lat + d], { units: "meters" }) / d;
  const perLon = distance([lon, lat], [lon + d, lat], { units: "meters" }) / d;
  return { lat: Math.max(perLat, 1), lon: Math.max(perLon, 1) };
}

/** Ordered, finite bbox. A degenerate bbox is replaced by a MIN_RADIUS_M square on the centre. */
function normaliseBbox(town: TownRef): [number, number, number, number] {
  const [b0, b1, b2, b3] = town.bbox;
  const west = Math.min(b0, b2);
  const east = Math.max(b0, b2);
  const south = Math.min(b1, b3);
  const north = Math.max(b1, b3);
  const ok =
    [west, south, east, north].every(Number.isFinite) && east > west && north > south;
  if (ok) return [west, south, east, north];
  const centre = centreOf(town);
  const per = metresPerDegree(centre);
  const dLat = MIN_RADIUS_M / per.lat;
  const dLon = MIN_RADIUS_M / per.lon;
  return [centre[0] - dLon, centre[1] - dLat, centre[0] + dLon, centre[1] + dLat];
}

function bboxDimensionsM(town: TownRef): { widthM: number; heightM: number } {
  const [west, south, east, north] = normaliseBbox(town);
  const midLat = clamp((south + north) / 2, -MAX_PROBE_LAT, MAX_PROBE_LAT);
  const midLon = (west + east) / 2;
  return {
    widthM: distance([west, midLat], [east, midLat], { units: "meters" }),
    heightM: distance([midLon, south], [midLon, north], { units: "meters" }),
  };
}

/** Effective analysis radius in metres derived from the town bbox (clamped 1500..12000). */
export function analysisRadiusM(town: TownRef): number {
  const { widthM, heightM } = bboxDimensionsM(town);
  // Half the mean bbox dimension: covers the built-up core without chasing a
  // bbox that a geocoder stretched over an entire administrative district.
  const half = (widthM + heightM) / 4;
  return Math.round(clamp(half, MIN_RADIUS_M, MAX_RADIUS_M));
}

function lattice(
  bbox: [number, number, number, number],
  centre: LngLat,
  per: { lat: number; lon: number },
  radiusM: number,
  cellM: number,
): { lon: number; lat: number }[] {
  const [west, south, east, north] = bbox;
  const latStep = (cellM * HEX_ROW_FACTOR) / per.lat;
  const lonStep = cellM / per.lon;
  if (!(latStep > 0) || !(lonStep > 0)) return [];

  const rows = Math.floor((north - south) / latStep) + 1;
  const r2 = radiusM * radiusM;
  const out: { lon: number; lat: number }[] = [];

  // Row-major, south -> north then west -> east. This ordering is what makes the
  // ids stable, so it must never be reordered or parallelised.
  for (let r = 0; r < rows && out.length < MAX_LATTICE_POINTS; r++) {
    const lat = south + r * latStep;
    const dy = (lat - centre[1]) * per.lat;
    const offset = r % 2 === 1 ? lonStep / 2 : 0;
    for (let c = 0; out.length < MAX_LATTICE_POINTS; c++) {
      const lon = west + offset + c * lonStep;
      if (lon > east) break;
      const dx = (lon - centre[0]) * per.lon;
      // Local equirectangular metric: exact enough over a <= 24 km analysis area
      // and far cheaper than a geodesic call per lattice node.
      if (dx * dx + dy * dy <= r2) out.push({ lon: round6(lon), lat: round6(lat) });
    }
  }
  return out;
}

function countGap(n: number): number {
  if (n < MIN_POINTS) return MIN_POINTS - n;
  if (n > MAX_POINTS) return n - MAX_POINTS;
  return 0;
}

/**
 * Hex-ish grid inside the town bbox, clipped to a radius from centre.
 * Deterministic: same town -> same points & ids. Targets 150-500 points by
 * auto-selecting cell size from bbox area.
 */
export function generateCandidateGrid(town: TownRef): CandidatePoint[] {
  const bbox = normaliseBbox(town);
  const centre = centreOf(town);
  const per = metresPerDegree(centre);
  const radiusM = analysisRadiusM(town);

  const { widthM, heightM } = bboxDimensionsM(town);
  // Each hex node owns cell x (cell * sqrt(3)/2) of ground, so inverting the
  // covered area for the ideal count gives a first-guess cell size.
  const covered = Math.max(Math.min(widthM * heightM, Math.PI * radiusM * radiusM), 1);
  let cellM = clamp(
    Math.sqrt(covered / (HEX_ROW_FACTOR * IDEAL_POINTS)),
    MIN_CELL_M,
    MAX_CELL_M,
  );

  let current = lattice(bbox, centre, per, radiusM, cellM);
  let best = current;
  let bestGap = countGap(current.length);
  let lastDir = 0;

  for (let i = 0; i < CELL_SEARCH_ITERATIONS && bestGap > 0; i++) {
    const dir = current.length > MAX_POINTS ? 1 : current.length < MIN_POINTS ? -1 : 0;
    if (dir === 0) break;
    // A direction flip means the band was stepped over; keep the closest lattice seen.
    if (lastDir !== 0 && dir !== lastDir) break;
    const next =
      dir === 1
        ? Math.min(MAX_CELL_M, cellM * CELL_SEARCH_STEP)
        : Math.max(MIN_CELL_M, cellM / CELL_SEARCH_STEP);
    if (next === cellM) break; // a cell-size bound was hit
    cellM = next;
    lastDir = dir;
    current = lattice(bbox, centre, per, radiusM, cellM);
    const gap = countGap(current.length);
    if (gap < bestGap) {
      best = current;
      bestGap = gap;
    }
  }

  return best.map((p, i) => ({
    id: `c${String(i).padStart(4, "0")}`,
    lon: p.lon,
    lat: p.lat,
  }));
}
