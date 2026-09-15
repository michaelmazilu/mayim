/**
 * Conceptual site layout.
 *
 * Produces the illustrative geometry drawn on the map for a chosen site: the
 * source, a storage tank on the highest ground that can be inferred, treatment
 * beside it, community tap stands pointed at the densest building clusters, and
 * the pipe runs that join them. It is a concept sketch for costing and
 * communication, not an engineering design — but it is fully deterministic and
 * its pipeline length is a true geodesic sum, because the cost model reads it.
 */

import { destination, distance } from "@turf/turf";
import { SERVICE } from "@/lib/config/coefficients";
import type { CandidateFeatures, InfrastructureType, LngLat, OsmData } from "@/lib/types";

export type ConceptualLayout = {
  source: LngLat; // borehole / intake
  tank: LngLat; // storage, placed uphill/adjacent
  treatment: LngLat;
  taps: LngLat[]; // 3-6 community tap stations toward building clusters
  pipes: LngLat[][]; // polylines source->tank->treatment->each tap
  serviceRadiusRing: LngLat[]; // closed ring polygon for the service radius
  pipelineLengthM: number;
  tapStandCount: number;
};

/** Per-type layout geometry. Tap-count bands reflect how the type distributes water. */
const LAYOUT_BY_TYPE: Record<
  InfrastructureType,
  { tankOffsetM: number; treatmentOffsetM: number; minTaps: number; maxTaps: number }
> = {
  solar_borehole: { tankOffsetM: 120, treatmentOffsetM: 35, minTaps: 3, maxTaps: 6 },
  borehole_rehabilitation: { tankOffsetM: 120, treatmentOffsetM: 30, minTaps: 3, maxTaps: 4 },
  // Catchment and storage co-locate, so the tank sits much closer to the source.
  rainwater_harvesting: { tankOffsetM: 60, treatmentOffsetM: 25, minTaps: 3, maxTaps: 4 },
  filtration_and_storage: { tankOffsetM: 120, treatmentOffsetM: 40, minTaps: 3, maxTaps: 5 },
  community_storage_and_taps: { tankOffsetM: 120, treatmentOffsetM: 30, minTaps: 4, maxTaps: 6 },
};

/** Taps sit at this fraction of the service radius along their cluster bearing. */
const TAP_RADIUS_FRACTION = 0.55;

/** Building bearings are bucketed into eight 45-degree octants. */
const OCTANT_COUNT = 8;
const OCTANT_DEGREES = 360 / OCTANT_COUNT;

/** Vertex count of the service-radius ring (plus a repeated closing vertex). */
const RING_SEGMENTS = 64;

/** Fallback octant preference (N, E, S, W, then the diagonals) when buildings are sparse. */
const FALLBACK_OCTANT_ORDER = [0, 2, 4, 6, 1, 3, 5, 7];

const EARTH_RADIUS_M = 6371008.8;
const M_PER_DEG_LAT = (Math.PI * EARTH_RADIUS_M) / 180;

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function toLngLat(coords: number[]): LngLat {
  return [round6(coords[0]), round6(coords[1])];
}

function offset(from: LngLat, metres: number, bearingDeg: number): LngLat {
  return toLngLat(
    destination(from, metres, bearingDeg, { units: "meters" }).geometry.coordinates,
  );
}

/** Local planar offsets in metres — used for bucketing and radius tests, not for output. */
function planarDelta(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
): { east: number; north: number } {
  const mPerDegLon = Math.max(M_PER_DEG_LAT * Math.cos((fromLat * Math.PI) / 180), 1);
  return {
    east: (toLon - fromLon) * mPerDegLon,
    north: (toLat - fromLat) * M_PER_DEG_LAT,
  };
}

function compassBearing(east: number, north: number): number {
  return (((Math.atan2(east, north) * 180) / Math.PI) + 360) % 360;
}

/**
 * Direction of probable higher ground. Water runs downhill, so the bearing that
 * points away from the nearest mapped channel is the best uphill guess available
 * without a DEM here. Falls back to north when no channel is close enough for
 * that reasoning to mean anything.
 */
function uphillBearing(
  site: { lon: number; lat: number },
  features: CandidateFeatures,
  osm: OsmData,
): number {
  if (features.distanceToWaterwayM > SERVICE.walkingRadiusM) return 0;

  let bestSq = Number.POSITIVE_INFINITY;
  let bestLon = 0;
  let bestLat = 0;
  for (const line of osm.waterways) {
    for (const c of line.coords) {
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      const d = planarDelta(site.lon, site.lat, c[0], c[1]);
      const d2 = d.east * d.east + d.north * d.north;
      if (d2 < bestSq) {
        bestSq = d2;
        bestLon = c[0];
        bestLat = c[1];
      }
    }
  }
  if (!Number.isFinite(bestSq) || bestSq === 0) return 0;

  const away = planarDelta(bestLon, bestLat, site.lon, site.lat);
  const brg = compassBearing(away.east, away.north);
  return Number.isFinite(brg) ? brg : 0;
}

/** Octant indices ordered by how many buildings fall in them, best first. */
function tapOctants(
  site: { lon: number; lat: number },
  osm: OsmData,
  serviceRadiusM: number,
  minTaps: number,
  maxTaps: number,
): number[] {
  const counts = new Array<number>(OCTANT_COUNT).fill(0);
  const r2 = serviceRadiusM * serviceRadiusM;
  for (const b of osm.buildings) {
    if (!Number.isFinite(b.lon) || !Number.isFinite(b.lat)) continue;
    const d = planarDelta(site.lon, site.lat, b.lon, b.lat);
    const d2 = d.east * d.east + d.north * d.north;
    if (d2 > r2 || d2 === 0) continue;
    const brg = compassBearing(d.east, d.north);
    const octant = Math.floor(((brg + OCTANT_DEGREES / 2) % 360) / OCTANT_DEGREES) % OCTANT_COUNT;
    counts[octant]++;
  }

  const ranked = counts
    .map((count, octant) => ({ count, octant }))
    .filter((entry) => entry.count > 0)
    // Descending by count, then ascending by octant so ties never reorder.
    .sort((a, b) => (b.count - a.count) || (a.octant - b.octant))
    .slice(0, maxTaps)
    .map((entry) => entry.octant);

  for (const octant of FALLBACK_OCTANT_ORDER) {
    if (ranked.length >= minTaps) break;
    if (!ranked.includes(octant)) ranked.push(octant);
  }
  return ranked;
}

function polylineLengthM(line: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    total += distance(line[i - 1], line[i], { units: "meters" });
  }
  return total;
}

export function buildConceptualLayout(args: {
  site: { lon: number; lat: number };
  features: CandidateFeatures;
  osm: OsmData;
  type: InfrastructureType;
  serviceRadiusM: number;
  /**
   * Upper bound on tap stands, derived from the population the system can
   * actually supply. Without it a low-yield borehole is drawn — and costed —
   * with a full ring of taps and kilometres of pipe it can never fill.
   */
  maxTaps?: number;
}): ConceptualLayout {
  const { site, features, osm, type } = args;
  const baseSpec = LAYOUT_BY_TYPE[type];
  const cap =
    args.maxTaps !== undefined && Number.isFinite(args.maxTaps)
      ? Math.max(1, Math.min(baseSpec.maxTaps, Math.floor(args.maxTaps)))
      : baseSpec.maxTaps;
  const spec = { ...baseSpec, maxTaps: cap, minTaps: Math.min(baseSpec.minTaps, cap) };
  const serviceRadiusM =
    args.serviceRadiusM > 0 ? args.serviceRadiusM : SERVICE.walkingRadiusM;

  const source: LngLat = [round6(site.lon), round6(site.lat)];
  const tankBearing = uphillBearing(site, features, osm);
  const tank = offset(source, spec.tankOffsetM, tankBearing);
  // Treatment sits beside the tank, perpendicular to the source-tank run, so the
  // two structures share a pad without the pipe doubling back on itself.
  const treatment = offset(tank, spec.treatmentOffsetM, (tankBearing + 90) % 360);

  const octants = tapOctants(site, osm, serviceRadiusM, spec.minTaps, spec.maxTaps);
  const tapDistanceM = serviceRadiusM * TAP_RADIUS_FRACTION;
  const taps = octants.map((octant) => offset(source, tapDistanceM, octant * OCTANT_DEGREES));

  const trunk: LngLat[] = [source, tank, treatment];
  const pipes: LngLat[][] = [trunk, ...taps.map((tap) => [treatment, tap])];
  const pipelineLengthM = Math.round(
    pipes.reduce((sum, line) => sum + polylineLengthM(line), 0),
  );

  const serviceRadiusRing: LngLat[] = [];
  for (let i = 0; i < RING_SEGMENTS; i++) {
    serviceRadiusRing.push(offset(source, serviceRadiusM, (i * 360) / RING_SEGMENTS));
  }
  serviceRadiusRing.push(serviceRadiusRing[0]);

  return {
    source,
    tank,
    treatment,
    taps,
    pipes,
    serviceRadiusRing,
    pipelineLengthM,
    tapStandCount: taps.length,
  };
}
