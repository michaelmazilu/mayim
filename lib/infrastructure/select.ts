/**
 * Infrastructure template selection and recommendation assembly.
 *
 * The choice of system is a deterministic decision tree over the candidate's
 * features and the site climate — no scoring soup, no randomness — so that every
 * recommendation can be explained by pointing at the input value that triggered
 * the rule.
 *
 * This module also does the physical sizing (storage volume, catchment area,
 * solar array) that the cost and output models consume as inputs.
 */

import type {
  CandidateFeatures,
  ClimateData,
  InfrastructureRecommendation,
  InfrastructureType,
  PopulationEstimate,
} from "@/lib/types";
import { DRILLING_DEPTH_M, WATER } from "@/lib/config/coefficients";
import { estimateCost, type CostInput } from "@/lib/cost-model/cost";
import { estimateOutput, type OutputInput } from "@/lib/water-output/output";

export type SelectionInput = {
  features: CandidateFeatures;
  climate: ClimateData;
  population: PopulationEstimate;
  /** true when a mapped water point exists within 600 m (rehabilitation candidate) */
  hasNearbyMappedWaterPoint: boolean;
  pipelineLengthM: number;
  tapStandCount: number;
  /** Build this type instead of running the decision tree. */
  forceType?: InfrastructureType;
};

// ---------------------------------------------------------------------------
// Decision thresholds and non-monetary sizing conventions.
// Prices and yields live in lib/config/coefficients.ts; these are the rule
// cut-offs and engineering conventions that drive the choice and the sizing.
// ---------------------------------------------------------------------------

const RULES = {
  /** Groundwater evidence at or above this justifies reusing an existing borehole. */
  rehabilitationGroundwaterMin: 0.45,
  /** Groundwater evidence at or above this justifies a new drilled borehole. */
  newBoreholeGroundwaterMin: 0.55,
  /** Peak-sun-hours needed before solar pumping is treated as viable. */
  adequateSolarKwhM2Day: 4.0,
  /** Below this, groundwater is treated as unlikely to be productive. */
  weakGroundwaterMax: 0.35,
  /** Rainfall at or above this makes roof harvesting worth building. */
  rainwaterRainfallMinMm: 700,
} as const;

/** Days of demand held in storage, by system type. */
const STORAGE_DAYS: Record<InfrastructureType, number> = {
  solar_borehole: 1,
  borehole_rehabilitation: 1,
  // Rainwater storage is sized from the catchment, not from demand-days.
  rainwater_harvesting: 0,
  filtration_and_storage: 1.5,
  community_storage_and_taps: 3,
};

const TANK_MIN_LITERS = 5_000;
const TANK_MAX_LITERS = 200_000;

/** Practical bounds on institutional roof area available for retrofit. */
const CATCHMENT_MIN_M2 = 50;
const CATCHMENT_MAX_M2 = 1_500;

/**
 * Rainwater sizing convention: 100 L of storage per m2 of roof. The cost model
 * inverts this to recover the catchment area it prices, so the identically
 * named constant in lib/cost-model/cost.ts must stay equal to this one.
 */
const STORAGE_LITERS_PER_CATCHMENT_M2 = 100;

/** Confidence shaping. Capped at 0.85 — this is a desk study, never a survey. */
const CONFIDENCE = {
  groundwaterFloor: 0.35,
  groundwaterEvidenceWeight: 0.3,
  groundwaterScoreWeight: 0.2,
  otherFloor: 0.4,
  otherEvidenceWeight: 0.35,
  otherIndependenceWeight: 0.1,
  ceiling: 0.85,
} as const;

const MAINTENANCE: Record<InfrastructureType, "low" | "moderate" | "high"> = {
  solar_borehole: "moderate",
  borehole_rehabilitation: "low",
  rainwater_harvesting: "low",
  filtration_and_storage: "high",
  community_storage_and_taps: "moderate",
};

const IMPLEMENTATION_WEEKS: Record<InfrastructureType, [number, number]> = {
  solar_borehole: [10, 20],
  borehole_rehabilitation: [4, 9],
  rainwater_harvesting: [6, 12],
  filtration_and_storage: [8, 16],
  community_storage_and_taps: [6, 14],
};

const LABELS: Record<InfrastructureType, string> = {
  solar_borehole: "Solar-powered borehole with storage and tap stands",
  borehole_rehabilitation: "Rehabilitation of the existing borehole",
  rainwater_harvesting: "Roof rainwater harvesting with seasonal storage",
  filtration_and_storage: "Filtration and treated storage on an existing supply",
  community_storage_and_taps: "Bulk-supplied community storage with tap stands",
};

// Physical constants (not planning coefficients).
const WATER_DENSITY_KG_M3 = 1000;
const GRAVITY_M_S2 = 9.81;
const JOULES_PER_WH = 3600;
const LITERS_PER_M3 = 1000;
const DAYS_PER_YEAR = 365;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const INT_FMT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function qty(n: number): string {
  return INT_FMT.format(Math.round(n));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n));
}

function fmt2(n: number): string {
  return n.toFixed(2);
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function selectInfrastructureType(input: SelectionInput): {
  type: InfrastructureType;
  rationale: string[];
} {
  const groundwater = clamp01(input.features.groundwaterEvidenceScore);
  const solar = input.climate.solarKwhM2Day;
  const rainfall = input.climate.annualRainfallMm;
  const nearestPoint = input.features.distanceToMappedWaterPointM;
  const climateNote = input.climate.estimated
    ? ` Climate figures are a fallback assumption (${input.climate.source}), not measured data for this site.`
    : "";

  if (input.hasNearbyMappedWaterPoint && groundwater >= RULES.rehabilitationGroundwaterMin) {
    return {
      type: "borehole_rehabilitation",
      rationale: [
        `A mapped water point already exists ${nearestPoint === undefined ? "within 600 m" : `${qty(nearestPoint)} m away`}, so the aquifer has already been reached at this location.`,
        `Groundwater evidence score is ${fmt2(groundwater)}, at or above the ${RULES.rehabilitationGroundwaterMin} threshold for trusting that existing source.`,
        "Restoring an existing borehole is the lowest capital cost per person served and avoids the drilling risk of a new hole entirely.",
      ],
    };
  }

  if (groundwater >= RULES.newBoreholeGroundwaterMin && solar >= RULES.adequateSolarKwhM2Day) {
    return {
      type: "solar_borehole",
      rationale: [
        `Groundwater evidence score is ${fmt2(groundwater)}, at or above the ${RULES.newBoreholeGroundwaterMin} threshold for committing to a new drilled borehole.`,
        `Solar resource is ${solar} kWh/m2/day, at or above the ${RULES.adequateSolarKwhM2Day} kWh/m2/day needed for a solar pump to run without a fuel supply chain.${climateNote}`,
        "No usable water point is mapped nearby, so there is no existing asset to rehabilitate instead.",
      ],
    };
  }

  if (groundwater < RULES.weakGroundwaterMax && rainfall >= RULES.rainwaterRainfallMinMm) {
    return {
      type: "rainwater_harvesting",
      rationale: [
        `Groundwater evidence score is ${fmt2(groundwater)}, below the ${RULES.weakGroundwaterMax} threshold — drilling here is a poor bet.`,
        `Annual rainfall is ${qty(rainfall)} mm, at or above the ${RULES.rainwaterRainfallMinMm} mm that makes roof harvesting worth the catchment investment.${climateNote}`,
        `With ${input.climate.drySeasonMonths} months below 30 mm, storage rather than yield is the binding constraint on this option.`,
      ],
    };
  }

  if (groundwater < RULES.weakGroundwaterMax && rainfall < RULES.rainwaterRainfallMinMm) {
    return {
      type: "community_storage_and_taps",
      rationale: [
        `Groundwater evidence score is ${fmt2(groundwater)}, below the ${RULES.weakGroundwaterMax} threshold, so on-site abstraction cannot be relied on.`,
        `Annual rainfall is only ${qty(rainfall)} mm, below the ${RULES.rainwaterRainfallMinMm} mm needed for roof harvesting to carry the load.${climateNote}`,
        "With neither groundwater nor rainfall available locally, water has to be brought in — bulk supply into community storage with tap stands is the remaining option.",
      ],
    };
  }

  return {
    type: "filtration_and_storage",
    rationale: [
      `Groundwater evidence score is ${fmt2(groundwater)} — above the ${RULES.weakGroundwaterMax} weak-groundwater threshold but below the ${RULES.newBoreholeGroundwaterMin} needed to justify drilling${solar < RULES.adequateSolarKwhM2Day ? `, and the solar resource of ${solar} kWh/m2/day is below the ${RULES.adequateSolarKwhM2Day} kWh/m2/day a solar pump needs` : ""}.`,
      `Annual rainfall of ${qty(rainfall)} mm does not make roof harvesting the obvious answer either.${climateNote}`,
      "The defensible intervention is therefore to make an existing but unsafe supply usable: filtration, disinfection and treated storage, sized to the community rather than to an unproven aquifer.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

type Sizing = {
  tankVolumeLiters: number;
  solarArrayWp: number;
  roofAreaM2: number;
  pumpingHeadM: number;
  depthBand: { low: number; high: number };
  storageDays: number;
};

/**
 * Mirrors the depth-band selection in lib/cost-model/cost.ts. The cost model is
 * only handed the confidence score, so both modules must read the same band off
 * the same thresholds; models.test.ts asserts the two stay in agreement.
 */
const DEPTH_BAND_THRESHOLDS = { favourable: 0.6, moderate: 0.35 } as const;

function depthBandFor(groundwaterConfidence: number): { low: number; high: number } {
  const c = clamp01(groundwaterConfidence);
  if (c >= DEPTH_BAND_THRESHOLDS.favourable) return DRILLING_DEPTH_M.favourable;
  if (c >= DEPTH_BAND_THRESHOLDS.moderate) return DRILLING_DEPTH_M.moderate;
  return DRILLING_DEPTH_M.difficult;
}

/** Pumping water level assumed at the mid-point of the priced depth band. */
function pumpingHeadM(band: { low: number; high: number }): number {
  return roundTo((band.low + band.high) / 2, 1);
}

/**
 * Array rating from the hydraulic work the pump must do:
 * E = rho * g * V * H, divided by the operational efficiency once per conversion
 * stage (array and controller, motor, pump and rising main), then divided by
 * peak sun hours to get a peak-watt rating.
 */
function solarArrayWp(dailyLiters: number, headM: number, solarKwhM2Day: number): number {
  if (dailyLiters <= 0 || headM <= 0 || solarKwhM2Day <= 0) return 0;
  const volumeM3 = dailyLiters / LITERS_PER_M3;
  const hydraulicWh = (WATER_DENSITY_KG_M3 * GRAVITY_M_S2 * volumeM3 * headM) / JOULES_PER_WH;
  const electricalWh = hydraulicWh / Math.pow(WATER.operationalEfficiency, 3);
  return Math.max(100, Math.ceil(electricalWh / solarKwhM2Day / 100) * 100);
}

/** Catchment area needed to meet annual demand, bounded by what a roof can be. */
function catchmentAreaM2(peopleServed: number, annualRainfallMm: number): number {
  const annualDemandLiters =
    Math.max(0, peopleServed) * WATER.litersPerPersonPerDay.value * DAYS_PER_YEAR;
  const rainfall = Math.max(1, annualRainfallMm);
  const required = annualDemandLiters / (rainfall * WATER.runoffCoefficient);
  return clamp(roundTo(required, 10), CATCHMENT_MIN_M2, CATCHMENT_MAX_M2);
}

/**
 * How many people a single installation of this type can physically supply.
 *
 * Output for every type except rainwater harvesting depends only on the site
 * and climate, never on demand, so capacity can be resolved before sizing.
 * Rainwater is bounded instead by the largest practical catchment.
 *
 * This is the cap that stops a site with 80,000 residents inside its walking
 * radius from being sized, costed and reported as if one borehole served them.
 */
function capacityPeople(type: InfrastructureType, input: SelectionInput): number {
  const out = estimateOutput(type, {
    solarKwhM2Day: input.climate.solarKwhM2Day,
    groundwaterConfidence: clamp01(input.features.groundwaterEvidenceScore),
    annualRainfallMm: input.climate.annualRainfallMm,
    roofAreaM2: type === "rainwater_harvesting" ? CATCHMENT_MAX_M2 : 0,
  });
  return Math.max(1, out.peopleSupportedHigh);
}

/** Demand the installation is sized against: residents, capped by what it can deliver. */
function sizingPeople(type: InfrastructureType, input: SelectionInput): number {
  return Math.min(Math.max(0, input.population.peopleServed), capacityPeople(type, input));
}

function sizeSystem(type: InfrastructureType, input: SelectionInput): Sizing {
  const groundwater = clamp01(input.features.groundwaterEvidenceScore);
  const depthBand = depthBandFor(groundwater);
  const headM = pumpingHeadM(depthBand);
  const storageDays = STORAGE_DAYS[type];
  const designPeople = sizingPeople(type, input);

  if (type === "rainwater_harvesting") {
    const roofAreaM2 = catchmentAreaM2(
      designPeople,
      input.climate.annualRainfallMm,
    );
    return {
      roofAreaM2,
      tankVolumeLiters: roofAreaM2 * STORAGE_LITERS_PER_CATCHMENT_M2,
      solarArrayWp: 0,
      pumpingHeadM: 0,
      depthBand,
      storageDays: 0,
    };
  }

  const demandLiters = designPeople * WATER.litersPerPersonPerDay.value;
  const tankVolumeLiters = clamp(
    roundTo(demandLiters * storageDays, 1000),
    TANK_MIN_LITERS,
    TANK_MAX_LITERS,
  );

  if (type !== "solar_borehole") {
    return {
      roofAreaM2: 0,
      tankVolumeLiters,
      solarArrayWp: 0,
      pumpingHeadM: headM,
      depthBand,
      storageDays,
    };
  }

  // The array is sized to the volume the borehole can actually deliver, not to
  // demand, so an under-yielding site is not given an oversized array.
  const provisional = estimateOutput("solar_borehole", {
    solarKwhM2Day: input.climate.solarKwhM2Day,
    groundwaterConfidence: groundwater,
    annualRainfallMm: input.climate.annualRainfallMm,
    roofAreaM2: 0,
  });
  return {
    roofAreaM2: 0,
    tankVolumeLiters,
    solarArrayWp: solarArrayWp(provisional.dailyLitersHigh, headM, input.climate.solarKwhM2Day),
    pumpingHeadM: headM,
    depthBand,
    storageDays,
  };
}

// ---------------------------------------------------------------------------
// Components, validation, confidence
// ---------------------------------------------------------------------------

function componentsFor(
  type: InfrastructureType,
  input: SelectionInput,
  sizing: Sizing,
): { name: string; detail: string }[] {
  const components: { name: string; detail: string }[] = [];

  if (type === "solar_borehole") {
    components.push({
      name: "Borehole",
      detail: `Drilled, cased and gravel-packed borehole in the ${sizing.depthBand.low}-${sizing.depthBand.high} m depth band implied by the groundwater evidence score. Actual depth is known only after drilling.`,
    });
    components.push({
      name: "Solar pumping",
      detail: `${qty(sizing.solarArrayWp)} Wp PV array, controller and submersible pump against an assumed ${qty(sizing.pumpingHeadM)} m pumping head.`,
    });
  }
  if (type === "borehole_rehabilitation") {
    components.push({
      name: "Borehole rehabilitation",
      detail:
        "Camera survey, flushing, re-development and headworks repair of the existing borehole.",
    });
    components.push({
      name: "Hand pump",
      detail: "Replacement hand pump, rising main and apron with a standardised spare-parts chain.",
    });
  }
  if (type === "rainwater_harvesting") {
    components.push({
      name: "Roof catchment",
      detail: `${qty(sizing.roofAreaM2)} m2 of guttered institutional roof with first-flush diverters and leaf screens.`,
    });
  }
  if (type === "filtration_and_storage") {
    components.push({
      name: "Treatment",
      detail:
        "Filtration unit with media, plus chlorination dosing and residual monitoring on the treated line.",
    });
  }
  if (type === "community_storage_and_taps") {
    components.push({
      name: "Bulk inlet",
      detail: "Tanker or mains fill point with a metered, chlorinated inlet to the storage tank.",
    });
  }

  components.push({
    name: "Storage",
    detail:
      type === "rainwater_harvesting"
        ? `${qty(sizing.tankVolumeLiters)} L of storage, sized at ${STORAGE_LITERS_PER_CATCHMENT_M2} L per m2 of catchment to bridge the ${input.climate.drySeasonMonths}-month dry season.`
        : `${qty(sizing.tankVolumeLiters)} L tank, sized at ${sizing.storageDays} day(s) of demand for ${qty(sizingPeople(type, input))} people at ${WATER.litersPerPersonPerDay.value} L/person/day.`,
  });

  if (input.pipelineLengthM > 0 || input.tapStandCount > 0) {
    components.push({
      name: "Distribution",
      detail: `${qty(input.pipelineLengthM)} m of conceptual distribution pipeline feeding ${qty(input.tapStandCount)} tap stand(s).`,
    });
  }
  components.push({
    name: "Monitoring",
    detail: "Flow and system-status sensors with remote reporting for post-handover verification.",
  });

  return components;
}

function requiredValidationFor(type: InfrastructureType): string[] {
  const validation: string[] = [
    "Hydrogeological review and ground geophysical survey (resistivity or TEM) at the shortlisted point before any commitment.",
  ];

  if (type === "solar_borehole") {
    validation.push(
      "Exploratory drilling with lithological logging and step-drawdown plus constant-rate pumping tests to establish sustainable yield.",
    );
  } else if (type === "borehole_rehabilitation") {
    validation.push(
      "Downhole camera survey and test pumping of the existing borehole to confirm it is recoverable before rehabilitation is funded.",
    );
  }

  validation.push(
    "Water-quality testing against national and WHO standards, including bacteriological, fluoride, arsenic, nitrate and salinity.",
    "Land ownership confirmation and legal right of access or easement for the site and the pipeline corridor.",
    "Community consultation on siting, tariff, and the operation and maintenance model, including who holds the spares.",
    "Seasonal access verification — confirm the approach is passable for rigs and delivery vehicles in the wet season.",
    "Environmental and social review, including abstraction licensing and downstream or aquifer impact.",
    "Final engineering design, bill of quantities and competitive tender.",
  );

  return validation;
}

function confidenceFor(type: InfrastructureType, features: CandidateFeatures): number {
  const evidence = clamp01(features.evidenceConfidence);
  const groundwater = clamp01(features.groundwaterEvidenceScore);
  const groundwaterDependent =
    type === "solar_borehole" || type === "borehole_rehabilitation";

  // Groundwater-dependent options inherit the uncertainty of the aquifer;
  // the others are only as good as the evidence base behind the site itself.
  const raw = groundwaterDependent
    ? CONFIDENCE.groundwaterFloor +
      CONFIDENCE.groundwaterEvidenceWeight * evidence +
      CONFIDENCE.groundwaterScoreWeight * groundwater
    : CONFIDENCE.otherFloor +
      CONFIDENCE.otherEvidenceWeight * evidence +
      CONFIDENCE.otherIndependenceWeight * (1 - groundwater);

  return Math.round(Math.min(CONFIDENCE.ceiling, raw) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

export function buildRecommendation(input: SelectionInput): InfrastructureRecommendation {
  const { type, rationale } = input.forceType
    ? {
        type: input.forceType,
        rationale: [
          `${LABELS[input.forceType]} was chosen by comparing every system type against the households it would serve, not by the screening rules.`,
        ],
      }
    : selectInfrastructureType(input);
  const sizing = sizeSystem(type, input);
  const groundwater = clamp01(input.features.groundwaterEvidenceScore);

  const outputInput: OutputInput = {
    solarKwhM2Day: input.climate.solarKwhM2Day,
    groundwaterConfidence: groundwater,
    annualRainfallMm: input.climate.annualRainfallMm,
    roofAreaM2: sizing.roofAreaM2,
  };
  const output = estimateOutput(type, outputInput);

  // Residents inside the walking radius vs. what one installation can supply.
  const servedLow = Math.min(input.population.rangeLow, output.peopleSupportedLow);
  const servedHigh = Math.min(input.population.rangeHigh, output.peopleSupportedHigh);
  const capacityBound = output.peopleSupportedHigh < input.population.rangeLow;
  const coverageNote = capacityBound
    ? `An estimated ${qty(input.population.rangeLow)}-${qty(input.population.rangeHigh)} people live within the ${qty(input.population.serviceRadiusM)} m service radius, but one installation of this type can supply ${qty(output.peopleSupportedLow)}-${qty(output.peopleSupportedHigh)}. The system is sized to its own sustainable yield; covering the full catchment would require multiple installations.`
    : `An estimated ${qty(input.population.rangeLow)}-${qty(input.population.rangeHigh)} people live within the ${qty(input.population.serviceRadiusM)} m service radius, which is within this system's sustainable yield of ${qty(output.peopleSupportedLow)}-${qty(output.peopleSupportedHigh)} people.`;

  const costInput: CostInput = {
    groundwaterConfidence: groundwater,
    distanceToRoadM: input.features.distanceToRoadM,
    slopeProxy: input.features.slopeProxy ?? 0,
    peopleServed: servedHigh,
    pipelineLengthM: input.pipelineLengthM,
    tapStandCount: input.tapStandCount,
    solarArrayWp: sizing.solarArrayWp,
    tankVolumeLiters: sizing.tankVolumeLiters,
  };
  const cost = estimateCost(type, costInput);

  const assumptions: string[] = [
    `Residents within the service radius: ${input.population.methodLabel} (range ${qty(input.population.rangeLow)}-${qty(input.population.rangeHigh)}).`,
    coverageNote,
    ...input.population.limitations,
    `Demand is taken as ${WATER.litersPerPersonPerDay.value} L/person/day (${WATER.litersPerPersonPerDay.source}).`,
  ];

  if (type === "rainwater_harvesting") {
    assumptions.push(
      `Catchment is capped at ${CATCHMENT_MAX_M2} m2 of available roof, so this option supports ${qty(output.peopleSupportedLow)}-${qty(output.peopleSupportedHigh)} people.`,
    );
  } else {
    assumptions.push(
      `Storage is sized at ${sizing.storageDays} day(s) of demand and bounded to ${qty(TANK_MIN_LITERS)}-${qty(TANK_MAX_LITERS)} L, the practical range for a single community installation.`,
    );
  }
  if (type === "solar_borehole") {
    assumptions.push(
      `Solar array sized from hydraulic work against an assumed ${qty(sizing.pumpingHeadM)} m pumping head, taken as the mid-point of the ${sizing.depthBand.low}-${sizing.depthBand.high} m depth band that the cost model prices.`,
    );
  }
  assumptions.push(
    `Pipeline length (${qty(input.pipelineLengthM)} m) and tap-stand count (${qty(input.tapStandCount)}) are a conceptual layout from the geospatial step, not a surveyed route.`,
    ...cost.assumptions,
  );

  return {
    type,
    label: LABELS[type],
    rationale,
    components: componentsFor(type, input, sizing),
    cost,
    output,
    peopleServedLow: servedLow,
    peopleServedHigh: servedHigh,
    coverageNote,
    maintenanceComplexity: MAINTENANCE[type],
    implementationRangeWeeks: IMPLEMENTATION_WEEKS[type],
    confidence: confidenceFor(type, input.features),
    assumptions,
    requiredValidation: requiredValidationFor(type),
    storageLiters: sizing.tankVolumeLiters,
    catchmentM2: sizing.roofAreaM2,
  };
}
