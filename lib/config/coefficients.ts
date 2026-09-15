/**
 * Mayim planning coefficients.
 *
 * Every number used by the cost and water-output models lives here, with an
 * explicit provenance label rendered in the UI. These are ORDER-OF-MAGNITUDE
 * PLANNING FIGURES for pre-feasibility screening, not quotations.
 */

export type Coefficient = {
  low: number;
  high: number;
  unit: string;
  source: string;
};

const RWSN = "RWSN/UNICEF rural water supply cost benchmarking (planning range)";
const DEMO = "Demo planning assumption";
const WHO = "WHO/UNICEF JMP service-level guidance";

export const COST: Record<string, Coefficient> = {
  sitePreparation: { low: 2500, high: 5000, unit: "USD", source: RWSN },
  drillingPerMeter: { low: 110, high: 190, unit: "USD/m", source: RWSN },
  boreholeRehabilitation: { low: 4000, high: 9000, unit: "USD", source: RWSN },
  submersiblePump: { low: 3200, high: 6500, unit: "USD", source: RWSN },
  handPump: { low: 1200, high: 2400, unit: "USD", source: RWSN },
  solarArrayPerWp: { low: 1.6, high: 2.9, unit: "USD/Wp", source: RWSN },
  tankPerLiter: { low: 0.28, high: 0.55, unit: "USD/L", source: RWSN },
  pipelinePerMeter: { low: 22, high: 48, unit: "USD/m", source: RWSN },
  tapStand: { low: 900, high: 1800, unit: "USD each", source: RWSN },
  treatmentChlorination: { low: 2200, high: 4800, unit: "USD", source: RWSN },
  filtrationUnit: { low: 6000, high: 13000, unit: "USD", source: RWSN },
  rainwaterCatchmentPerM2: { low: 38, high: 72, unit: "USD/m2", source: DEMO },
  monitoringSensors: { low: 800, high: 1900, unit: "USD", source: DEMO },
};

/** Drilling depth assumptions by groundwater-evidence confidence. */
export const DRILLING_DEPTH_M = {
  favourable: { low: 40, high: 70, source: DEMO },
  moderate: { low: 60, high: 95, source: DEMO },
  difficult: { low: 85, high: 130, source: DEMO },
};

export const WATER = {
  /** Sustainable abstraction from a hand-drilled/small motorised borehole. */
  pumpRateLitersPerHour: { low: 1800, high: 3600, unit: "L/h", source: RWSN },
  handPumpRateLitersPerHour: { low: 700, high: 1100, unit: "L/h", source: RWSN },
  /** Fraction of peak-sun-hours usable for pumping. */
  solarPumpingHoursFactor: 0.78,
  /** Combined pump/pipe/storage losses and downtime. */
  operationalEfficiency: 0.82,
  /** WHO basic-service planning figure. */
  litersPerPersonPerDay: { value: 20, source: WHO },
  /** Rainwater harvesting runoff coefficient for a metal/tile roof. */
  runoffCoefficient: 0.8,
};

export const SERVICE = {
  /** Max reasonable walking distance to a water point (JMP "basic service" is 30 min round trip). */
  walkingRadiusM: 1000,
  /** Radius used to count nearby buildings when computing density. */
  densityRadiusM: 400,
  /** A mapped water point this close means the site is redundant. */
  redundancyRadiusM: 350,
  /** Beyond this from a road, construction access is impractical. */
  maxRoadDistanceM: 1200,
  /** Closer than this to a mapped hazard is excluded. */
  hazardBufferM: 300,
  /** Closer than this to a waterway centreline is treated as in-channel. */
  waterwayBufferM: 30,
  /** Average household size used for the building-to-people conversion. */
  peoplePerBuilding: { low: 4.2, high: 6.4, source: DEMO },
};

/** Deterministic suitability weights. Must sum to 1. */
export const WEIGHTS = {
  communityNeed: 0.25,
  populationAccessProxy: 0.2,
  groundwaterFeasibility: 0.18,
  roadAndConstructionAccess: 0.12,
  distanceFromExistingService: 0.1,
  environmentalSafety: 0.1,
  evidenceQuality: 0.05,
} as const;

export const WEIGHT_LABELS: Record<keyof typeof WEIGHTS, string> = {
  communityNeed: "Community need",
  populationAccessProxy: "Population access proxy",
  groundwaterFeasibility: "Groundwater feasibility",
  roadAndConstructionAccess: "Road & construction access",
  distanceFromExistingService: "Distance from existing service",
  environmentalSafety: "Environmental safety",
  evidenceQuality: "Evidence quality",
};

/** Fallback climate used only when NASA POWER is unreachable. Clearly labelled in UI. */
export const CLIMATE_FALLBACK = {
  annualRainfallMm: 850,
  solarKwhM2Day: 5.4,
  source: "Fallback planning assumption (live climate provider unavailable)",
};

const SPHERE = "Sphere Handbook water supply standard (planning indicator)";
const RWSN_FUNCTIONALITY =
  "RWSN: roughly one in four handpumps in sub-Saharan Africa is non-functional at any time";

/**
 * Household behaviour, reliability and growth figures for the household
 * simulation (lib/popsim). Planning figures, each with a source label; they are
 * replaced rather than tuned when a better source is found.
 */
export const BEHAVIOUR = {
  walkingSpeedKmh: { value: 4, source: DEMO },
  /** Straight-line walks are stretched by this where no mapped path joins the two points. */
  detourFactor: { value: 1.3, source: DEMO },
  containerLitres: { value: 20, source: DEMO },
  /** Flow of one tap, which sets the time to fill a container and so the queue. */
  tapFlowLitresPerMinute: { value: 7.5, source: SPHERE },
  /** People one tap stand is designed for. */
  peoplePerTap: { value: 250, source: SPHERE },
  /** Hours a tap stand dispenses each day; with the flow, its physical daily limit. */
  tapWindowHours: { value: 12, source: DEMO },
  maxWaitMinutes: { value: 60, source: DEMO },
  basicServiceRoundTripMinutes: { value: 30, source: WHO },
  /** Round trip assumed for a household with no mapped improved source within reach. */
  noSourceRoundTripMinutes: { value: 60, source: DEMO },
  /** Long-run share of time a source is out of service. */
  nonFunctionalShare: {
    existing: 0.25,
    project: 0.1,
    source: `${RWSN_FUNCTIONALITY}; new systems: ${DEMO}`,
  },
  repairWeeks: { low: 2, high: 8, source: DEMO },
  annualGrowthRate: { value: 0.035, source: DEMO },
  /** Share of each year's growth that settles in new clusters rather than densifying existing ones. */
  sprawlShare: { value: 0.3, source: DEMO },
  /** Each year's rainfall is the climatology scaled by up to this fraction either way. */
  rainfallYearVariation: { value: 0.2, source: DEMO },
  /** A future holds when mean people served over the horizon stays at or above this share of the design. */
  passThreshold: { value: 0.8, source: DEMO },
  /** The recommendation must hold in at least this share of futures to count as robust. */
  robustShare: { value: 0.7, source: DEMO },
  horizonYears: { value: 10, source: DEMO },
};

/**
 * Whole-life costs, so an option that is cheap to build but expensive to run
 * (trucked water, filter consumables) cannot win on capital cost alone.
 */
export const LIFECYCLE = {
  annualOmShare: {
    solar_borehole: 0.03,
    borehole_rehabilitation: 0.05,
    rainwater_harvesting: 0.02,
    filtration_and_storage: 0.06,
    community_storage_and_taps: 0.03,
  },
  perM3Delivered: {
    solar_borehole: 0,
    borehole_rehabilitation: 0,
    rainwater_harvesting: 0,
    filtration_and_storage: 0.45,
    community_storage_and_taps: 3.5,
  },
  source: DEMO,
};
