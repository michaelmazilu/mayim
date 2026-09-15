import type { ElevationSample, LngLat, TerrainData } from "@/lib/types";
import { fetchJson } from "@/lib/providers/fetchWithTimeout";

/**
 * Coarse terrain sampling for the HAND/flood and slope proxies.
 * Two keyless providers are tried in order; the first that answers wins.
 */

const OPEN_ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup";
const OPENTOPODATA_URL = "https://api.opentopodata.org/v1/srtm30m";

const TIMEOUT_MS = 15_000;
/** Both providers accept at most 100 locations per request. */
const MAX_POINTS_PER_CALL = 100;
/** OpenTopoData is rate limited to ~1 request/second. */
const OPENTOPODATA_GAP_MS = 1100;

/** 9 x 9 = 81 grid points: inside the 60-90 target and under the per-call cap. */
const GRID_SIDE = 9;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function r6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Deterministic, edge-inclusive lattice over [west, south, east, north]. */
function buildGrid(bbox: [number, number, number, number]): LngLat[] {
  const [west, south, east, north] = bbox;
  const points: LngLat[] = [];
  const span = GRID_SIDE - 1;
  for (let row = 0; row < GRID_SIDE; row += 1) {
    const lat = r6(south + ((north - south) * row) / span);
    for (let col = 0; col < GRID_SIDE; col += 1) {
      const lon = r6(west + ((east - west) * col) / span);
      points.push([lon, lat]);
    }
  }
  return points;
}

function chunk(points: LngLat[], size: number): LngLat[][] {
  const out: LngLat[][] = [];
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size));
  return out;
}

function isElevation(v: unknown): v is number {
  // SRTM voids come back as null; -32768 is the raster's no-data value.
  return typeof v === "number" && Number.isFinite(v) && v > -20000;
}

type OpenElevationResponse = { results?: { elevation?: number | null }[] };
type OpenTopoDataResponse = {
  status?: string;
  results?: { elevation?: number | null }[];
};

/**
 * Pairs provider results back onto the REQUESTED coordinates by index — both APIs
 * preserve request order, and using our own coordinates keeps output deterministic.
 */
function collect(points: LngLat[], elevations: (number | null | undefined)[]): ElevationSample[] {
  const samples: ElevationSample[] = [];
  const n = Math.min(points.length, elevations.length);
  for (let i = 0; i < n; i += 1) {
    const value = elevations[i];
    if (!isElevation(value)) continue;
    const [lon, lat] = points[i];
    samples.push({ lon, lat, elevationM: Math.round(value * 10) / 10 });
  }
  return samples;
}

async function viaOpenElevation(batches: LngLat[][]): Promise<ElevationSample[] | null> {
  const samples: ElevationSample[] = [];
  for (const batch of batches) {
    const json = await fetchJson<OpenElevationResponse>(
      OPEN_ELEVATION_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          locations: batch.map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
        }),
        cache: "no-store",
      },
      TIMEOUT_MS,
    );
    if (!json || !Array.isArray(json.results)) return null;
    samples.push(...collect(batch, json.results.map((r) => r.elevation)));
  }
  return samples.length > 0 ? samples : null;
}

async function viaOpenTopoData(batches: LngLat[][]): Promise<ElevationSample[] | null> {
  const samples: ElevationSample[] = [];
  for (let i = 0; i < batches.length; i += 1) {
    if (i > 0) await sleep(OPENTOPODATA_GAP_MS); // respect the ~1 req/sec limit
    const batch = batches[i];
    const locations = batch.map(([lon, lat]) => `${lat},${lon}`).join("|");
    const json = await fetchJson<OpenTopoDataResponse>(
      `${OPENTOPODATA_URL}?locations=${encodeURIComponent(locations)}`,
      { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" },
      TIMEOUT_MS,
    );
    if (!json || json.status !== "OK" || !Array.isArray(json.results)) return null;
    samples.push(...collect(batch, json.results.map((r) => r.elevation)));
  }
  return samples.length > 0 ? samples : null;
}

function summarise(samples: ElevationSample[], source: string): TerrainData {
  let minM = samples[0].elevationM;
  let maxM = samples[0].elevationM;
  for (const s of samples) {
    if (s.elevationM < minM) minM = s.elevationM;
    if (s.elevationM > maxM) maxM = s.elevationM;
  }
  return { samples, minM, maxM, source, estimated: false };
}

const UNAVAILABLE: TerrainData = {
  samples: [],
  minM: 0,
  maxM: 0,
  source: "unavailable",
  estimated: true,
};

/** Samples a coarse grid over the bbox (aim for 60-90 points, never more than 100 per HTTP call). */
export async function fetchTerrain(bbox: [number, number, number, number]): Promise<TerrainData> {
  try {
    const batches = chunk(buildGrid(bbox), MAX_POINTS_PER_CALL);

    const openElevation = await viaOpenElevation(batches);
    if (openElevation) return summarise(openElevation, "Open-Elevation API (SRTM)");

    const openTopoData = await viaOpenTopoData(batches);
    if (openTopoData) return summarise(openTopoData, "OpenTopoData SRTM 30m");

    return { ...UNAVAILABLE, samples: [] };
  } catch {
    return { ...UNAVAILABLE, samples: [] };
  }
}
