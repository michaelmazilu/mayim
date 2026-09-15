/**
 * WorldPop gridded population — an independent cross-check on the
 * building-weighted population estimate.
 *
 * The WorldPop stats service sums the 100 m "Global per country" raster over a
 * GeoJSON polygon. That series stops at 2020, so the figure is reported with
 * its year and never silently projected forward. Licence: CC BY 4.0.
 */

import { circle } from "@turf/turf";
import type { LngLat } from "@/lib/types";
import { fetchWithTimeout } from "@/lib/providers/fetchWithTimeout";

const ENDPOINT = "https://api.worldpop.org/v1/services/stats";
/**
 * The service computes synchronously and only sends headers when done —
 * observed 2–10 s per call. One generous attempt beats two short ones: a retry
 * after a timeout just queues the same computation again.
 */
const TIMEOUT_MS = 25_000;

export const WORLDPOP = {
  dataset: "wpgppop",
  /** Latest year the global per-country series covers; the API rejects later years. */
  year: 2020,
  source: "WorldPop Global per-country 2020, 100 m (University of Southampton, CC BY 4.0)",
} as const;

type StatsResponse = {
  error?: boolean;
  data?: { total_population?: unknown };
};

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

/** Service-area polygon, coordinates rounded so the GET URL stays short. */
export function servicePolygon(center: LngLat, radiusM: number, steps = 32) {
  const geometry = circle(center, radiusM / 1000, { steps, units: "kilometers" }).geometry;
  return {
    type: "Polygon" as const,
    coordinates: geometry.coordinates.map((ring) => ring.map(([lon, lat]) => [round5(lon), round5(lat)])),
  };
}

/** People inside the circle per WorldPop, or null if the service is unreachable. Never throws. */
export async function fetchWorldPopWithin(
  center: LngLat,
  radiusM: number,
): Promise<{ people: number; year: number; dataset: string; source: string } | null> {
  if (!Number.isFinite(center[0]) || !Number.isFinite(center[1]) || !(radiusM > 0)) return null;
  const geojson = JSON.stringify(servicePolygon(center, radiusM));
  const url =
    `${ENDPOINT}?dataset=${WORLDPOP.dataset}&year=${WORLDPOP.year}&runasync=false` +
    `&geojson=${encodeURIComponent(geojson)}`;
  let res: StatsResponse | null = null;
  try {
    const response = await fetchWithTimeout(url, { cache: "no-store" }, TIMEOUT_MS);
    if (response.ok) res = (await response.json()) as StatsResponse;
  } catch {
    return null;
  }
  // "status" may read "started" even when the total is already present; the total is what counts.
  const total = res?.data?.total_population;
  if (res?.error || typeof total !== "number" || !Number.isFinite(total) || total < 0) return null;
  return { people: Math.round(total), year: WORLDPOP.year, dataset: WORLDPOP.dataset, source: WORLDPOP.source };
}
