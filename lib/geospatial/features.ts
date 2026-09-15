/**
 * Per-candidate feature computation.
 *
 * This runs server-side over up to 500 candidates against potentially tens of
 * thousands of OSM vertices, so every nearest-neighbour and radius query goes
 * through a uniform spatial hash grid built once per context. Distances use a
 * local equirectangular metric (metres-per-degree fixed at the data's mean
 * latitude); over a <= 24 km analysis area the error against a geodesic is well
 * under 0.1 %, and it avoids allocating a GeoJSON feature per comparison.
 */

import { booleanPointInPolygon, polygon } from "@turf/turf";
import { SERVICE } from "@/lib/config/coefficients";
import type {
  CandidateFeatures,
  EvidenceSignals,
  LngLat,
  OsmData,
  OsmLine,
  OsmPoint,
  OsmPolygon,
  TerrainData,
} from "@/lib/types";
import type { CandidatePoint } from "@/lib/geospatial/candidates";

export type FeatureContext = {
  osm: OsmData;
  terrain: TerrainData;
  signals: EvidenceSignals;
  /** metres; used for the density counting radius */
  densityRadiusM: number;
};

// ---------------------------------------------------------------------------
// Model constants (structural, not cost/output coefficients)
// ---------------------------------------------------------------------------

/**
 * Sentinel reported for the two REQUIRED distance fields when OSM has no element
 * of that kind at all. Optional distance fields stay `undefined` instead.
 */
const NO_FEATURE_DISTANCE_M = 99999;

/** Height above nearest drainage at which flood exposure is treated as nil. */
const HAND_DRY_HEIGHT_M = 25;

/** Grade (rise/run) treated as a fully steep site for the 0..1 slope proxy. */
const SLOPE_FULL_SCALE_GRADE = 0.15;

/** Terrain may nudge the groundwater evidence score by at most this much, either way. */
const GROUNDWATER_TERRAIN_MODULATION = 0.12;

/** Slope neighbourhood radius as a multiple of the terrain sample spacing. */
const SLOPE_NEIGHBOURHOOD_FACTOR = 1.6;
const SLOPE_NEIGHBOURHOOD_FALLBACK_FACTOR = 4;

/** Floor on the inferred terrain sample spacing, metres. */
const MIN_TERRAIN_SPACING_M = 30;

// ---------------------------------------------------------------------------
// Spatial hash grid
// ---------------------------------------------------------------------------

type IndexedPoint = { lon: number; lat: number; value: number };
type NearestHit = IndexedPoint & { distM: number };

/** WGS84 mean radius — the same figure turf uses, kept local for the hot path. */
const EARTH_RADIUS_M = 6371008.8;
const M_PER_DEG_LAT = (Math.PI * EARTH_RADIUS_M) / 180;

const GRID_CELL_M = 250;
/** Below this many points a linear scan beats any bucketing. */
const LINEAR_SCAN_LIMIT = 300;
/** Ring expansion cap; beyond it an exact linear scan is cheaper than empty rings. */
const RING_CAP = 16;
const KEY_OFFSET = 1_000_000;
const KEY_SPAN = 4_000_000;

class SpatialGrid {
  readonly count: number;
  private readonly pts: IndexedPoint[];
  private readonly buckets: Map<number, number[]> | null;
  private readonly cellM: number;
  private readonly mPerDegLon: number;
  private readonly cellLatDeg: number;
  private readonly cellLonDeg: number;
  private readonly minRow: number;
  private readonly maxRow: number;
  private readonly minCol: number;
  private readonly maxCol: number;

  constructor(pts: IndexedPoint[], cellM: number = GRID_CELL_M) {
    this.pts = pts;
    this.count = pts.length;
    this.cellM = cellM;

    let latSum = 0;
    for (const p of pts) latSum += p.lat;
    const refLat = pts.length > 0 ? latSum / pts.length : 0;
    this.mPerDegLon = Math.max(M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180), 1);
    this.cellLatDeg = cellM / M_PER_DEG_LAT;
    this.cellLonDeg = cellM / this.mPerDegLon;

    let minRow = 0;
    let maxRow = 0;
    let minCol = 0;
    let maxCol = 0;
    let buckets: Map<number, number[]> | null = null;

    if (pts.length > LINEAR_SCAN_LIMIT) {
      buckets = new Map<number, number[]>();
      minRow = Number.POSITIVE_INFINITY;
      maxRow = Number.NEGATIVE_INFINITY;
      minCol = Number.POSITIVE_INFINITY;
      maxCol = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const row = Math.floor(p.lat / this.cellLatDeg);
        const col = Math.floor(p.lon / this.cellLonDeg);
        if (row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
        const k = (row + KEY_OFFSET) * KEY_SPAN + (col + KEY_OFFSET);
        const bucket = buckets.get(k);
        if (bucket === undefined) buckets.set(k, [i]);
        else bucket.push(i);
      }
    }

    this.buckets = buckets;
    this.minRow = minRow;
    this.maxRow = maxRow;
    this.minCol = minCol;
    this.maxCol = maxCol;
  }

  private key(row: number, col: number): number {
    return (row + KEY_OFFSET) * KEY_SPAN + (col + KEY_OFFSET);
  }

  private distSq(lon: number, lat: number, p: IndexedPoint): number {
    const dLat = (lat - p.lat) * M_PER_DEG_LAT;
    const dLon = (lon - p.lon) * this.mPerDegLon;
    return dLat * dLat + dLon * dLon;
  }

  private scanAll(lon: number, lat: number): NearestHit | null {
    let bestSq = Number.POSITIVE_INFINITY;
    let bestIdx = -1;
    for (let i = 0; i < this.pts.length; i++) {
      const d2 = this.distSq(lon, lat, this.pts[i]);
      if (d2 < bestSq) {
        bestSq = d2;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null;
    const p = this.pts[bestIdx];
    return { lon: p.lon, lat: p.lat, value: p.value, distM: Math.sqrt(bestSq) };
  }

  /** Nearest indexed point, or null when the grid is empty. */
  nearest(lon: number, lat: number): NearestHit | null {
    if (this.count === 0) return null;
    const buckets = this.buckets;
    if (buckets === null) return this.scanAll(lon, lat);

    const row = Math.floor(lat / this.cellLatDeg);
    const col = Math.floor(lon / this.cellLonDeg);
    const naturalLimit = Math.max(
      row - this.minRow,
      this.maxRow - row,
      col - this.minCol,
      this.maxCol - col,
    );
    const limit = Math.min(RING_CAP, naturalLimit);

    let bestSq = Number.POSITIVE_INFINITY;
    let bestIdx = -1;
    for (let r = 0; r <= limit; r++) {
      for (let dr = -r; dr <= r; dr++) {
        const edgeRow = dr === -r || dr === r;
        for (let dc = -r; dc <= r; dc++) {
          if (!edgeRow && dc !== -r && dc !== r) continue; // interior already scanned
          const bucket = buckets.get(this.key(row + dr, col + dc));
          if (bucket === undefined) continue;
          for (const i of bucket) {
            const d2 = this.distSq(lon, lat, this.pts[i]);
            if (d2 < bestSq) {
              bestSq = d2;
              bestIdx = i;
            }
          }
        }
      }
      // Anything still unscanned sits at least r whole cells away on one axis.
      if (bestIdx >= 0 && bestSq <= (r * this.cellM) ** 2) break;
    }

    if (bestIdx >= 0 && (naturalLimit <= RING_CAP || bestSq <= (limit * this.cellM) ** 2)) {
      const p = this.pts[bestIdx];
      return { lon: p.lon, lat: p.lat, value: p.value, distM: Math.sqrt(bestSq) };
    }
    // Ring search hit its cap without proving optimality: the nearest element is
    // kilometres away, so an exact linear pass is both correct and cheap enough.
    return this.scanAll(lon, lat);
  }

  private forEachWithin(
    lon: number,
    lat: number,
    radiusM: number,
    fn: (p: IndexedPoint) => void,
  ): void {
    if (this.count === 0 || !(radiusM > 0)) return;
    const r2 = radiusM * radiusM;
    const buckets = this.buckets;
    if (buckets === null) {
      for (const p of this.pts) if (this.distSq(lon, lat, p) <= r2) fn(p);
      return;
    }
    const rings = Math.ceil(radiusM / this.cellM);
    const row = Math.floor(lat / this.cellLatDeg);
    const col = Math.floor(lon / this.cellLonDeg);
    for (let dr = -rings; dr <= rings; dr++) {
      for (let dc = -rings; dc <= rings; dc++) {
        const bucket = buckets.get(this.key(row + dr, col + dc));
        if (bucket === undefined) continue;
        for (const i of bucket) {
          const p = this.pts[i];
          if (this.distSq(lon, lat, p) <= r2) fn(p);
        }
      }
    }
  }

  countWithin(lon: number, lat: number, radiusM: number): number {
    let n = 0;
    this.forEachWithin(lon, lat, radiusM, () => {
      n++;
    });
    return n;
  }

  within(lon: number, lat: number, radiusM: number): IndexedPoint[] {
    const out: IndexedPoint[] = [];
    this.forEachWithin(lon, lat, radiusM, (p) => {
      out.push(p);
    });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Prepared index
// ---------------------------------------------------------------------------

type ProtectedArea = {
  poly: ReturnType<typeof polygon>;
  west: number;
  south: number;
  east: number;
  north: number;
};

type GeoIndex = {
  roads: SpatialGrid;
  /** Waterway vertices; `value` carries the drainage datum elevation (NaN when unknown). */
  waterways: SpatialGrid;
  buildings: SpatialGrid;
  facilities: SpatialGrid;
  schools: SpatialGrid;
  clinics: SpatialGrid;
  waterPoints: SpatialGrid;
  hazards: SpatialGrid;
  /** Terrain samples; `value` is elevation in metres. */
  terrain: SpatialGrid;
  protectedAreas: ProtectedArea[];
  hasTerrain: boolean;
  terrainMinM: number;
  terrainRangeM: number;
  slopeRadiusM: number;
};

function lineVertices(lines: OsmLine[]): IndexedPoint[] {
  // Nearest-vertex rather than nearest-point-on-segment. OSM ways are already
  // vertex-dense (a few metres to a few tens of metres apart), so the error is
  // small and bounded, and this avoids a pointToLineDistance over every segment.
  const out: IndexedPoint[] = [];
  for (const line of lines) {
    for (const c of line.coords) {
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        out.push({ lon: c[0], lat: c[1], value: Number.NaN });
      }
    }
  }
  return out;
}

function nodePoints(points: OsmPoint[]): IndexedPoint[] {
  const out: IndexedPoint[] = [];
  for (const p of points) {
    if (Number.isFinite(p.lon) && Number.isFinite(p.lat)) {
      out.push({ lon: p.lon, lat: p.lat, value: Number.NaN });
    }
  }
  return out;
}

function prepareProtectedAreas(areas: OsmPolygon[]): ProtectedArea[] {
  const out: ProtectedArea[] = [];
  for (const area of areas) {
    const ring = area.ring.filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
    if (ring.length < 3) continue;
    const first = ring[0];
    const last = ring[ring.length - 1];
    const closed: LngLat[] =
      first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
    if (closed.length < 4) continue;
    let west = Number.POSITIVE_INFINITY;
    let south = Number.POSITIVE_INFINITY;
    let east = Number.NEGATIVE_INFINITY;
    let north = Number.NEGATIVE_INFINITY;
    for (const c of closed) {
      if (c[0] < west) west = c[0];
      if (c[0] > east) east = c[0];
      if (c[1] < south) south = c[1];
      if (c[1] > north) north = c[1];
    }
    out.push({ poly: polygon([closed]), west, south, east, north });
  }
  return out;
}

/** Inferred sample spacing of the terrain raster, metres. */
function terrainSpacingM(samples: IndexedPoint[]): number {
  if (samples.length < 2) return MIN_TERRAIN_SPACING_M;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    if (s.lon < west) west = s.lon;
    if (s.lon > east) east = s.lon;
    if (s.lat < south) south = s.lat;
    if (s.lat > north) north = s.lat;
  }
  const midLat = (south + north) / 2;
  const mPerDegLon = Math.max(M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180), 1);
  const spanY = (north - south) * M_PER_DEG_LAT;
  const spanX = (east - west) * mPerDegLon;
  const area = Math.max(spanX * spanY, 1);
  return Math.max(Math.sqrt(area / samples.length), MIN_TERRAIN_SPACING_M);
}

function buildIndex(ctx: FeatureContext): GeoIndex {
  const osm = ctx.osm;

  const terrainSamples: IndexedPoint[] = [];
  let terrainMinM = Number.POSITIVE_INFINITY;
  let terrainMaxM = Number.NEGATIVE_INFINITY;
  for (const s of ctx.terrain.samples) {
    if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat) || !Number.isFinite(s.elevationM)) {
      continue;
    }
    terrainSamples.push({ lon: s.lon, lat: s.lat, value: s.elevationM });
    if (s.elevationM < terrainMinM) terrainMinM = s.elevationM;
    if (s.elevationM > terrainMaxM) terrainMaxM = s.elevationM;
  }
  const hasTerrain = terrainSamples.length > 0;
  const terrain = new SpatialGrid(terrainSamples);

  const waterwayVertices = lineVertices(osm.waterways);
  // HAND datum: each waterway vertex carries the elevation of its nearest terrain
  // sample, so a candidate's height above nearest drainage is one lookup away.
  if (hasTerrain) {
    for (const v of waterwayVertices) {
      const hit = terrain.nearest(v.lon, v.lat);
      if (hit !== null) v.value = hit.value;
    }
  }

  const schools = nodePoints(osm.schools);
  const clinics = nodePoints(osm.clinics);

  const spacing = terrainSpacingM(terrainSamples);

  return {
    roads: new SpatialGrid(lineVertices(osm.roads)),
    waterways: new SpatialGrid(waterwayVertices),
    buildings: new SpatialGrid(nodePoints(osm.buildings)),
    facilities: new SpatialGrid([...schools, ...clinics]),
    schools: new SpatialGrid(schools),
    clinics: new SpatialGrid(clinics),
    waterPoints: new SpatialGrid(nodePoints(osm.waterPoints)),
    hazards: new SpatialGrid(nodePoints(osm.hazards)),
    terrain,
    protectedAreas: prepareProtectedAreas(osm.protectedAreas),
    hasTerrain,
    terrainMinM: hasTerrain ? terrainMinM : 0,
    terrainRangeM: hasTerrain ? Math.max(terrainMaxM - terrainMinM, 0) : 0,
    slopeRadiusM: spacing * SLOPE_NEIGHBOURHOOD_FACTOR,
  };
}

/**
 * The public FeatureContext shape is fixed by the module contract, so the derived
 * spatial index is memoised against the context object instead of living on it.
 */
const INDEX_CACHE = new WeakMap<FeatureContext, GeoIndex>();

function indexFor(ctx: FeatureContext): GeoIndex {
  const cached = INDEX_CACHE.get(ctx);
  if (cached !== undefined) return cached;
  const built = buildIndex(ctx);
  INDEX_CACHE.set(ctx, built);
  return built;
}

// ---------------------------------------------------------------------------
// Feature maths
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function slopeProxyAt(lon: number, lat: number, idx: GeoIndex): number | undefined {
  if (!idx.hasTerrain || idx.terrain.count < 2) return undefined;
  let neighbours = idx.terrain.within(lon, lat, idx.slopeRadiusM);
  if (neighbours.length < 2) {
    neighbours = idx.terrain.within(
      lon,
      lat,
      (idx.slopeRadiusM / SLOPE_NEIGHBOURHOOD_FACTOR) * SLOPE_NEIGHBOURHOOD_FALLBACK_FACTOR,
    );
  }
  if (neighbours.length < 2) return undefined;

  let lo = neighbours[0];
  let hi = neighbours[0];
  for (const n of neighbours) {
    if (n.value < lo.value) lo = n;
    if (n.value > hi.value) hi = n;
  }
  const rise = hi.value - lo.value;
  if (rise <= 0) return 0;

  // Run is measured between the highest and lowest sample in the neighbourhood —
  // the pair that produced the rise — so the ratio is a real local grade.
  const midLat = (hi.lat + lo.lat) / 2;
  const mPerDegLon = Math.max(M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180), 1);
  const dy = (hi.lat - lo.lat) * M_PER_DEG_LAT;
  const dx = (hi.lon - lo.lon) * mPerDegLon;
  const run = Math.sqrt(dx * dx + dy * dy);
  if (!(run > 0)) return undefined;

  return round3(clamp01(rise / run / SLOPE_FULL_SCALE_GRADE));
}

function floodProxyAt(
  elevationM: number | undefined,
  drainageElevationM: number | undefined,
  distanceToWaterwayM: number,
  hasWaterways: boolean,
): number {
  if (
    elevationM !== undefined &&
    drainageElevationM !== undefined &&
    Number.isFinite(drainageElevationM)
  ) {
    // HAND: height above nearest drainage. At or below the drainage datum the
    // site is treated as fully exposed; HAND_DRY_HEIGHT_M above it, as dry.
    const hand = elevationM - drainageElevationM;
    return round3(clamp01(1 - hand / HAND_DRY_HEIGHT_M));
  }
  if (!hasWaterways) return 0;
  // Coarse fallback when terrain is unavailable: proximity to a mapped channel.
  const span = Math.max(SERVICE.walkingRadiusM - SERVICE.waterwayBufferM, 1);
  return round3(clamp01(1 - (distanceToWaterwayM - SERVICE.waterwayBufferM) / span));
}

function groundwaterScoreAt(
  base: number,
  elevationM: number | undefined,
  idx: GeoIndex,
): number {
  const evidence = clamp01(base);
  if (elevationM === undefined || !idx.hasTerrain || idx.terrainRangeM <= 0) {
    return round3(evidence);
  }
  // Valley positions score slightly above ridge positions, but the modulation is
  // capped so the evidence base always dominates.
  const relative = clamp01((elevationM - idx.terrainMinM) / idx.terrainRangeM);
  const nudge = (0.5 - relative) * 2 * GROUNDWATER_TERRAIN_MODULATION;
  return round3(clamp01(evidence + nudge));
}

function insideAnyProtectedArea(lon: number, lat: number, areas: ProtectedArea[]): boolean {
  for (const area of areas) {
    if (lon < area.west || lon > area.east || lat < area.south || lat > area.north) continue;
    if (booleanPointInPolygon([lon, lat], area.poly)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildFeatureContext(
  osm: OsmData,
  terrain: TerrainData,
  signals: EvidenceSignals,
): FeatureContext {
  const ctx: FeatureContext = {
    osm,
    terrain,
    signals,
    densityRadiusM: SERVICE.densityRadiusM,
  };
  // Build the spatial index eagerly so the cost is paid once, up front.
  indexFor(ctx);
  return ctx;
}

export function computeFeatures(pt: CandidatePoint, ctx: FeatureContext): CandidateFeatures {
  const idx = indexFor(ctx);
  const { lon, lat } = pt;

  const road = idx.roads.nearest(lon, lat);
  const waterway = idx.waterways.nearest(lon, lat);
  const school = idx.schools.nearest(lon, lat);
  const clinic = idx.clinics.nearest(lon, lat);
  const waterPoint = idx.waterPoints.nearest(lon, lat);
  const hazard = idx.hazards.nearest(lon, lat);

  const distanceToRoadM = road === null ? NO_FEATURE_DISTANCE_M : round1(road.distM);
  const distanceToWaterwayM =
    waterway === null ? NO_FEATURE_DISTANCE_M : round1(waterway.distM);

  const radiusM = ctx.densityRadiusM > 0 ? ctx.densityRadiusM : SERVICE.densityRadiusM;
  const nearbyBuildingCount = idx.buildings.countWithin(lon, lat, radiusM);
  const nearbyCommunityFacilityCount = idx.facilities.countWithin(lon, lat, radiusM);

  const terrainHit = idx.terrain.nearest(lon, lat);
  const rawElevationM = terrainHit === null ? undefined : terrainHit.value;
  const drainageElevationM =
    waterway === null || !Number.isFinite(waterway.value) ? undefined : waterway.value;

  return {
    distanceToRoadM,
    distanceToWaterwayM,
    distanceToSchoolM: school === null ? undefined : round1(school.distM),
    distanceToClinicM: clinic === null ? undefined : round1(clinic.distM),
    distanceToMappedWaterPointM: waterPoint === null ? undefined : round1(waterPoint.distM),
    nearbyBuildingCount,
    nearbyCommunityFacilityCount,
    elevationM: rawElevationM === undefined ? undefined : round1(rawElevationM),
    slopeProxy: slopeProxyAt(lon, lat, idx),
    nearWasteOrIndustrialSite: hazard !== null && hazard.distM <= SERVICE.hazardBufferM,
    insideProtectedArea: insideAnyProtectedArea(lon, lat, idx.protectedAreas),
    floodProxy: floodProxyAt(
      rawElevationM,
      drainageElevationM,
      distanceToWaterwayM,
      idx.waterways.count > 0,
    ),
    groundwaterEvidenceScore: groundwaterScoreAt(ctx.signals.groundwater, rawElevationM, idx),
    evidenceConfidence: round3(clamp01(ctx.signals.quality)),
  };
}

/** Convenience: features for every point, plus the observed maxima needed by ScoringContext. */
export function computeAllFeatures(
  pts: CandidatePoint[],
  ctx: FeatureContext,
): {
  features: Map<string, CandidateFeatures>;
  maxNearbyBuildings: number;
  maxNearbyFacilities: number;
} {
  const features = new Map<string, CandidateFeatures>();
  let maxNearbyBuildings = 0;
  let maxNearbyFacilities = 0;
  for (const pt of pts) {
    const f = computeFeatures(pt, ctx);
    features.set(pt.id, f);
    if (f.nearbyBuildingCount > maxNearbyBuildings) maxNearbyBuildings = f.nearbyBuildingCount;
    if (f.nearbyCommunityFacilityCount > maxNearbyFacilities) {
      maxNearbyFacilities = f.nearbyCommunityFacilityCount;
    }
  }
  return { features, maxNearbyBuildings, maxNearbyFacilities };
}
