import type {
  Candidate,
  CandidateFeatures,
  CandidateScore,
  EvidenceSignals,
  ScoreBreakdown,
  ScoreFactor,
} from "@/lib/types";
import { SERVICE, WEIGHTS } from "@/lib/config/coefficients";
import { computeExclusions, computeWarnings } from "@/lib/scoring/exclusions";
import { clamp01, forwardNormalize, inverseNormalize, saturate } from "@/lib/scoring/normalize";

export type ScoringContext = {
  signals: EvidenceSignals;
  /** Max nearbyBuildingCount observed across the candidate set, for relative density scoring. Min 1. */
  maxNearbyBuildings: number;
  /** Max nearbyCommunityFacilityCount observed. Min 1. */
  maxNearbyFacilities: number;
};

/**
 * Sub-weights *inside* each of the seven factors. The seven factor weights
 * themselves are the project-level coefficients and live in
 * lib/config/coefficients.ts (WEIGHTS); these only describe how raw features
 * are mixed into a single 0..1 value per factor. Each group sums to 1.
 */
const BLEND = {
  /** Relative building density carries the factor; evidence tunes it. */
  need: { density: 0.6, evidence: 0.4 },
  populationAccess: { buildings: 0.45, facilities: 0.25, facilityProximity: 0.3 },
  /** Flood stays small on purpose: a wet site must never look "good" here. */
  groundwater: { evidence: 0.6, slope: 0.25, flood: 0.15 },
  construction: { road: 0.65, slope: 0.25, evidence: 0.1 },
  evidence: { candidate: 0.6, corpus: 0.4 },
} as const;

/** environmentalSafety starts at 1 and can lose at most these amounts. */
const SAFETY_PENALTY = { flood: 0.35, waterwayProximity: 0.2, evidenceRisk: 0.25 } as const;

/** Ceiling forced on environmentalSafety when a hard environmental flag is set. */
const SAFETY_FLAGGED_CEILING = 0.05;

/** Fraction of the observed maximum count that already scores ~0.86. */
const RELATIVE_SATURATION_FRACTION = 0.6;

/** Walking-distance window for school/clinic proximity, in metres. */
const FACILITY_PROXIMITY_M = { best: 200, worst: 1500 } as const;

/** A road this close is ideal for rig access; SERVICE.maxRoadDistanceM is the far end. */
const ROAD_ACCESS_BEST_M = 50;

/** Upper end of the "far enough from existing service" ramp, in metres. */
const SERVICE_SEPARATION_BEST_M = 2500;

/**
 * Used when the mapped water-point layer yielded nothing to measure against.
 * Deliberately NOT 1.0 — unmapped is not the same as unserved.
 */
const UNKNOWN_SERVICE_SEPARATION = 0.65;

/** Neutral stand-ins for optional features so a missing sample is not a penalty. */
const NEUTRAL = { slope: 0.35, facilityProximity: 0.4 } as const;

/**
 * A moderate flood proxy implies a shallow water table (good for drilling), so
 * the flood term peaks mid-range rather than at zero. Environmental safety
 * penalises the wet end separately, which is why this weight is small.
 */
const FLOOD_BELL = { peak: 0.45, width: 0.35 } as const;

/** Below this a signal did not materially move the score, so its sources are not cited. */
const MATERIAL_SIGNAL = 0.15;

function round4(v: number): number {
  return Math.round(clamp01(v) * 1e4) / 1e4;
}

/** Diminishing-returns count score, rescaled against the maximum seen in this run. */
function relativeCountScore(count: number, observedMax: number): number {
  const max = Number.isFinite(observedMax) ? Math.max(1, observedMax) : 1;
  return saturate(count, Math.max(1, max * RELATIVE_SATURATION_FRACTION));
}

function proximityScore(distanceM: number | undefined): number {
  if (distanceM === undefined) return NEUTRAL.facilityProximity;
  return inverseNormalize(distanceM, FACILITY_PROXIMITY_M.best, FACILITY_PROXIMITY_M.worst);
}

function shallowWaterTableBell(floodProxy: number): number {
  const d = clamp01(floodProxy) - FLOOD_BELL.peak;
  return clamp01(Math.exp(-(d * d) / (2 * FLOOD_BELL.width * FLOOD_BELL.width)));
}

/** Cite only the findings behind factors that actually moved this candidate's score. */
function collectEvidenceIds(f: CandidateFeatures, signals: EvidenceSignals): string[] {
  const material: ScoreFactor[] = [];
  if (clamp01(signals.need) >= MATERIAL_SIGNAL) material.push("need");
  if (clamp01(f.groundwaterEvidenceScore) >= MATERIAL_SIGNAL) material.push("groundwater");
  if (clamp01(signals.risk) >= MATERIAL_SIGNAL) material.push("risk");
  if (clamp01(signals.access) >= MATERIAL_SIGNAL) material.push("access");

  const ids = new Set<string>();
  for (const factor of material) {
    for (const id of signals.contributors[factor] ?? []) ids.add(id);
  }
  return [...ids].sort();
}

export function scoreCandidate(f: CandidateFeatures, ctx: ScoringContext): CandidateScore {
  const { signals } = ctx;
  const exclusions = computeExclusions(f);
  const warnings = computeWarnings(f);

  const density = relativeCountScore(f.nearbyBuildingCount, ctx.maxNearbyBuildings);
  const facilities = relativeCountScore(f.nearbyCommunityFacilityCount, ctx.maxNearbyFacilities);
  const slope = clamp01(f.slopeProxy ?? NEUTRAL.slope);
  const flatness = 1 - slope;

  const communityNeed =
    BLEND.need.density * density + BLEND.need.evidence * clamp01(signals.need);

  const facilityProximity =
    (proximityScore(f.distanceToSchoolM) + proximityScore(f.distanceToClinicM)) / 2;
  const populationAccessProxy =
    BLEND.populationAccess.buildings * density +
    BLEND.populationAccess.facilities * facilities +
    BLEND.populationAccess.facilityProximity * facilityProximity;

  const groundwaterFeasibility =
    BLEND.groundwater.evidence * clamp01(f.groundwaterEvidenceScore) +
    BLEND.groundwater.slope * flatness +
    BLEND.groundwater.flood * shallowWaterTableBell(f.floodProxy);

  const roadAndConstructionAccess =
    BLEND.construction.road *
      inverseNormalize(f.distanceToRoadM, ROAD_ACCESS_BEST_M, SERVICE.maxRoadDistanceM) +
    BLEND.construction.slope * flatness +
    BLEND.construction.evidence * (1 - clamp01(signals.access));

  const distanceFromExistingService =
    f.distanceToMappedWaterPointM === undefined
      ? UNKNOWN_SERVICE_SEPARATION
      : forwardNormalize(
          f.distanceToMappedWaterPointM,
          SERVICE.redundancyRadiusM,
          SERVICE_SEPARATION_BEST_M,
        );

  // The only continuous hazard distance carried on CandidateFeatures is the
  // waterway centreline (the contamination pathway); mapped waste/industrial
  // sites arrive as a boolean, so that flag applies a ceiling, not a gradient.
  const waterwayClearance = forwardNormalize(
    f.distanceToWaterwayM,
    SERVICE.waterwayBufferM,
    SERVICE.hazardBufferM,
  );
  let environmentalSafety =
    1 -
    SAFETY_PENALTY.flood * clamp01(f.floodProxy) -
    SAFETY_PENALTY.waterwayProximity * (1 - waterwayClearance) -
    SAFETY_PENALTY.evidenceRisk * clamp01(signals.risk);
  if (f.insideProtectedArea || f.nearWasteOrIndustrialSite) {
    environmentalSafety = Math.min(environmentalSafety, SAFETY_FLAGGED_CEILING);
  }

  const evidenceQuality =
    BLEND.evidence.candidate * clamp01(f.evidenceConfidence) +
    BLEND.evidence.corpus * clamp01(signals.quality);

  const breakdown: ScoreBreakdown = {
    communityNeed: round4(communityNeed),
    populationAccessProxy: round4(populationAccessProxy),
    groundwaterFeasibility: round4(groundwaterFeasibility),
    roadAndConstructionAccess: round4(roadAndConstructionAccess),
    distanceFromExistingService: round4(distanceFromExistingService),
    environmentalSafety: round4(environmentalSafety),
    evidenceQuality: round4(evidenceQuality),
  };

  // Weighted sum of the ROUNDED values, so the per-factor figures shown in the
  // UI always reconstruct the headline number exactly.
  const weighted =
    breakdown.communityNeed * WEIGHTS.communityNeed +
    breakdown.populationAccessProxy * WEIGHTS.populationAccessProxy +
    breakdown.groundwaterFeasibility * WEIGHTS.groundwaterFeasibility +
    breakdown.roadAndConstructionAccess * WEIGHTS.roadAndConstructionAccess +
    breakdown.distanceFromExistingService * WEIGHTS.distanceFromExistingService +
    breakdown.environmentalSafety * WEIGHTS.environmentalSafety +
    breakdown.evidenceQuality * WEIGHTS.evidenceQuality;

  return {
    overall: exclusions.length > 0 ? 0 : round4(weighted),
    breakdown,
    exclusions,
    warnings,
    supportingEvidenceIds: collectEvidenceIds(f, signals),
  };
}

/** Sorts non-excluded candidates by overall desc. Ties broken by id ascending for stability. Returns ids. */
export function rankCandidates(candidates: Candidate[]): string[] {
  return candidates
    .filter((c) => !c.excluded && c.score.exclusions.length === 0)
    .sort((a, b) => {
      const oa = Number.isFinite(a.score.overall) ? a.score.overall : 0;
      const ob = Number.isFinite(b.score.overall) ? b.score.overall : 0;
      if (ob !== oa) return ob - oa;
      // Code-unit comparison, not localeCompare: locale-independent and stable.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((c) => c.id);
}
