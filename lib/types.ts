/**
 * Mayim — shared type contract.
 * Single source of truth. Every module imports from here; nothing here imports from a module.
 */

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

export type LngLat = [number, number]; // [longitude, latitude]

export type TownRef = {
  /** Stable slug used as the cache key, e.g. "kisumu-kenya". */
  slug: string;
  name: string;
  region?: string;
  country?: string;
  /** Human-readable "Kisumu, Kisumu County, Kenya". */
  displayName: string;
  center: LngLat;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  /** Population from the geocoder when available (OSM extratags / Mapbox). */
  populationHint?: number;
  populationHintYear?: string;
  populationHintSource?: string;
};

// ---------------------------------------------------------------------------
// OpenStreetMap layer bundle
// ---------------------------------------------------------------------------

export type OsmPoint = {
  id: string;
  lon: number;
  lat: number;
  name?: string;
  kind: string;
};

export type OsmLine = {
  id: string;
  coords: LngLat[];
  name?: string;
  kind: string;
};

export type OsmPolygon = {
  id: string;
  ring: LngLat[];
  name?: string;
  kind: string;
};

export type OsmData = {
  roads: OsmLine[];
  waterways: OsmLine[];
  buildings: OsmPoint[]; // building centroids — cheaper than full footprints
  schools: OsmPoint[];
  clinics: OsmPoint[];
  waterPoints: OsmPoint[]; // wells, boreholes, water towers, reservoirs, taps
  hazards: OsmPoint[]; // waste / industrial / landfill
  protectedAreas: OsmPolygon[];
  /**
   * buildingsReturnedByOverpass / buildingsKept. 1 when nothing was dropped.
   * Absolute building-density estimates MUST scale by this, or a city whose
   * footprints were capped is reported as a village.
   */
  buildingSampleRatio: number;
  /** True when the Overpass call failed or timed out and this bundle is empty. */
  degraded: boolean;
  note?: string;
};

export const EMPTY_OSM: OsmData = {
  roads: [],
  waterways: [],
  buildings: [],
  schools: [],
  clinics: [],
  waterPoints: [],
  hazards: [],
  protectedAreas: [],
  buildingSampleRatio: 1,
  degraded: true,
  note: "OpenStreetMap data unavailable",
};

// ---------------------------------------------------------------------------
// Climate / terrain
// ---------------------------------------------------------------------------

export type ClimateData = {
  /** Mean annual precipitation, mm/year. */
  annualRainfallMm: number;
  /** Monthly precipitation, mm/day, Jan..Dec. */
  monthlyRainfallMmDay: number[];
  /** Peak-sun-hours equivalent, kWh/m2/day. */
  solarKwhM2Day: number;
  /** Count of months below 30 mm — a dry-season proxy. */
  drySeasonMonths: number;
  source: string;
  estimated: boolean; // true when a fallback assumption was used
};

export type ElevationSample = { lon: number; lat: number; elevationM: number };

export type TerrainData = {
  samples: ElevationSample[];
  minM: number;
  maxM: number;
  source: string;
  estimated: boolean;
};

// ---------------------------------------------------------------------------
// Evidence (Exa retrieval + LLM structuring)
// ---------------------------------------------------------------------------

export type EvidenceCategory =
  | "water_need"
  | "hydrogeology"
  | "infrastructure"
  | "environment"
  | "regulation";

export type ScoreFactor = "need" | "groundwater" | "risk" | "cost" | "access";

export type EvidenceFinding = {
  id: string;
  category: EvidenceCategory;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  publishedDate?: string;
  /** 0..1 */
  confidence: number;
  scoreImpact?: {
    factor: ScoreFactor;
    direction: "increase" | "decrease" | "unknown";
    /** 0..1 — magnitude of the adjustment applied to the factor. */
    magnitude: number;
  };
};

/**
 * Where a run's findings came from:
 *   live     — retrieved by Exa during this run;
 *   snapshot — a saved earlier live search for this town (data/evidence/);
 *   bundled  — hand-written institutional placeholders (no search was run).
 */
export type EvidenceProvenance = "live" | "snapshot" | "bundled";

/** Aggregated, deterministic roll-up of findings into scoring inputs. */
export type EvidenceSignals = {
  /** 0..1 — how strongly evidence indicates unmet water need. */
  need: number;
  /** 0..1 — confidence that productive groundwater exists. */
  groundwater: number;
  /** 0..1 — environmental / contamination / flood risk indicated by evidence. */
  risk: number;
  /** 0..1 — cost pressure indicated by evidence. */
  cost: number;
  /** 0..1 — access difficulty indicated by evidence. */
  access: number;
  /** 0..1 — quality/authority of the evidence base overall. */
  quality: number;
  /** Finding ids that contributed, per factor. */
  contributors: Record<ScoreFactor, string[]>;
};

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export type CandidateFeatures = {
  distanceToRoadM: number;
  distanceToWaterwayM: number;
  distanceToSchoolM?: number;
  distanceToClinicM?: number;
  distanceToMappedWaterPointM?: number;
  nearbyBuildingCount: number;
  nearbyCommunityFacilityCount: number;
  elevationM?: number;
  slopeProxy?: number; // 0..1
  nearWasteOrIndustrialSite: boolean;
  insideProtectedArea: boolean;
  floodProxy: number; // 0..1 — HAND-derived, higher = wetter/riskier
  groundwaterEvidenceScore: number; // 0..1
  evidenceConfidence: number; // 0..1
};

export type ScoreBreakdown = {
  communityNeed: number;
  populationAccessProxy: number;
  groundwaterFeasibility: number;
  roadAndConstructionAccess: number;
  distanceFromExistingService: number;
  environmentalSafety: number;
  evidenceQuality: number;
};

export type CandidateScore = {
  overall: number;
  breakdown: ScoreBreakdown;
  exclusions: string[];
  warnings: string[];
  supportingEvidenceIds: string[];
};

export type Candidate = {
  id: string;
  lon: number;
  lat: number;
  features: CandidateFeatures;
  score: CandidateScore;
  excluded: boolean;
};

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

export type PopulationEstimate = {
  peopleServed: number;
  /** Reported as a range to avoid false precision. */
  rangeLow: number;
  rangeHigh: number;
  serviceRadiusM: number;
  method:
    | "geocoder_population_building_weighted"
    | "building_density_proxy"
    | "facility_density_proxy";
  methodLabel: string;
  confidence: number; // 0..1
  limitations: string[];
  /**
   * Independent cross-check: WorldPop gridded population summed over the
   * service-radius circle. Absent when the WorldPop API was unreachable.
   */
  worldpop?: {
    people: number;
    /** Latest year the WorldPop global per-country series covers. */
    year: number;
    dataset: string;
    source: string;
  };
};

// ---------------------------------------------------------------------------
// Partners (organisations a planner could approach)
// ---------------------------------------------------------------------------

export type PartnerKind = "ngo" | "multilateral" | "government" | "utility" | "network" | "funder";

export type PartnerFocus =
  | "boreholes"
  | "handpumps"
  | "solar_pumping"
  | "piped_schemes"
  | "rainwater"
  | "water_quality"
  | "maintenance"
  | "sanitation"
  | "funding"
  | "policy"
  | "emergency";

export type Partner = {
  id: string;
  name: string;
  kind: PartnerKind;
  /** ISO 3166-1 alpha-2 country code, or "global" for multi-country organisations. */
  country: string;
  url: string;
  /** Country-programme page, when the organisation has one. */
  countryUrl?: string;
  description: string;
  focus: PartnerFocus[];
  /**
   * verified — curated list, URLs checked by hand (see lastVerified);
   * search   — surfaced by live Exa search this run; not reviewed.
   */
  source: "verified" | "search";
  lastVerified?: string;
};

// ---------------------------------------------------------------------------
// Infrastructure / cost / output
// ---------------------------------------------------------------------------

export type InfrastructureType =
  | "solar_borehole"
  | "borehole_rehabilitation"
  | "rainwater_harvesting"
  | "filtration_and_storage"
  | "community_storage_and_taps";

export type CostLineItem = {
  label: string;
  /** Formula rendered for the UI, e.g. "60 m x $145/m". */
  formula: string;
  low: number;
  high: number;
  /** Where the coefficient came from. */
  source: string;
};

export type CostEstimate = {
  lineItems: CostLineItem[];
  subtotalLow: number;
  subtotalHigh: number;
  accessMultiplier: number;
  accessMultiplierReason: string;
  totalLow: number;
  totalHigh: number;
  currency: "USD";
  assumptions: string[];
};

export type WaterOutputEstimate = {
  pumpRateLitersPerHour: number;
  effectivePumpingHours: number;
  operationalEfficiency: number;
  formula: string;
  dailyLitersLow: number;
  dailyLitersHigh: number;
  litersPerPersonPerDay: number;
  peopleSupportedLow: number;
  peopleSupportedHigh: number;
  caveats: string[];
};

export type InfrastructureRecommendation = {
  type: InfrastructureType;
  label: string;
  rationale: string[];
  components: { name: string; detail: string }[];
  cost: CostEstimate;
  output: WaterOutputEstimate;
  /** People the system can actually supply: min(population in radius, hydraulic capacity). */
  peopleServedLow: number;
  peopleServedHigh: number;
  /** Explains the relationship between demand in the radius and system capacity. */
  coverageNote: string;
  maintenanceComplexity: "low" | "moderate" | "high";
  implementationRangeWeeks: [number, number];
  confidence: number; // 0..1
  assumptions: string[];
  requiredValidation: string[];
};


/**
 * Conceptual infrastructure schematic for the winning site.
 * Structurally identical to `ConceptualLayout` in lib/geospatial/layout.ts —
 * declared here so it can travel inside a serialized AnalysisRun without
 * creating an import cycle.
 */
export type ConceptualLayoutData = {
  source: LngLat;
  tank: LngLat;
  treatment: LngLat;
  taps: LngLat[];
  pipes: LngLat[][];
  serviceRadiusRing: LngLat[];
  pipelineLengthM: number;
  tapStandCount: number;
};

// ---------------------------------------------------------------------------
// Analysis events (the "Live analysis" feed)
// ---------------------------------------------------------------------------

export type TrackId =
  | "water_access"
  | "hydrogeology"
  | "existing_infrastructure"
  | "population_access"
  | "environmental_risk"
  | "construction_access";

export type TrackStatus = "pending" | "active" | "complete" | "degraded";

export type AnalysisEvent = {
  id: string;
  track: TrackId;
  message: string;
  /** Epoch ms — real wall-clock time from the run. */
  ts: number;
  status: TrackStatus;
  /** Number of sources this event accounted for, when relevant. */
  sourceCount?: number;
};

export const TRACKS: { id: TrackId; label: string }[] = [
  { id: "water_access", label: "Water Access" },
  { id: "hydrogeology", label: "Hydrogeology" },
  { id: "existing_infrastructure", label: "Existing Infrastructure" },
  { id: "population_access", label: "Population & Community Access" },
  { id: "environmental_risk", label: "Environmental Risk" },
  { id: "construction_access", label: "Construction Accessibility" },
];

// ---------------------------------------------------------------------------
// The complete run
// ---------------------------------------------------------------------------

export type DataSourceStatus = {
  name: string;
  ok: boolean;
  detail: string;
};

export type AnalysisRun = {
  version: 1;
  town: TownRef;
  createdAt: number;
  /** "live" = fetched now; "cache" = saved run replayed; "demo" = bundled snapshot. */
  provenance: "live" | "cache" | "demo";
  events: AnalysisEvent[];
  osm: OsmData;
  climate: ClimateData;
  terrain: TerrainData;
  findings: EvidenceFinding[];
  /** Absent on runs cached before this field existed; treat as "bundled". */
  evidenceProvenance?: EvidenceProvenance;
  signals: EvidenceSignals;
  /** Organisations to approach. Absent on older cached runs — use /api/partners. */
  partners?: Partner[];
  candidates: Candidate[];
  candidateCount: number;
  excludedCount: number;
  ranked: string[]; // candidate ids, best first (excluded removed)
  winnerId: string | null;
  population: PopulationEstimate;
  recommendation: InfrastructureRecommendation | null;
  layout: ConceptualLayoutData | null;
  /** Short plain-language summary; LLM-written when available, deterministic otherwise. */
  narrative: string;
  narrativeSource: "llm" | "deterministic";
  whyThisSite: { claim: string; basis: string; kind: "map" | "evidence" | "assumption"; evidenceId?: string }[];
  alternatives: { candidateId: string; comparison: string }[];
  dataSources: DataSourceStatus[];
  warnings: string[];
};
