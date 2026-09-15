/**
 * AquaSite planning coefficients.
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
