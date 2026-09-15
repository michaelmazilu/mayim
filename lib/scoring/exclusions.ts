import type { CandidateFeatures } from "@/lib/types";
import { SERVICE } from "@/lib/config/coefficients";

/** Above this gradient proxy a site is not buildable without major earthworks. */
const MAX_BUILDABLE_SLOPE = 0.85;

/** Thresholds for soft warnings. These reduce confidence, they never exclude. */
const WARN = {
  /** floodProxy above this is worth flagging for a seasonal-inundation check. */
  flood: 0.6,
  /** slopeProxy above this (but still buildable) means extra earthworks. */
  slope: 0.6,
  /** Fraction of SERVICE.maxRoadDistanceM beyond which the access spur is long. */
  roadDistanceFraction: 0.6,
  /** Fewer mapped buildings than this suggests thin OSM coverage, not emptiness. */
  sparseBuildings: 15,
  /** Candidate evidence confidence below this is a thin base. */
  thinEvidence: 0.35,
  /** Groundwater evidence below this needs a survey before any drilling. */
  weakGroundwater: 0.3,
} as const;

/** Returns human-readable exclusion reasons. Empty array = candidate survives. */
export function computeExclusions(f: CandidateFeatures): string[] {
  const reasons: string[] = [];

  if (f.insideProtectedArea) {
    reasons.push("Inside a mapped protected area");
  }
  if (f.nearWasteOrIndustrialSite) {
    reasons.push(`Within ${SERVICE.hazardBufferM} m of a mapped waste or industrial site`);
  }
  if (f.distanceToWaterwayM < SERVICE.waterwayBufferM) {
    reasons.push("Within the mapped waterway channel");
  }
  if (f.distanceToRoadM > SERVICE.maxRoadDistanceM) {
    reasons.push("Beyond practical construction access from a mapped road");
  }
  if (f.slopeProxy !== undefined && f.slopeProxy > MAX_BUILDABLE_SLOPE) {
    reasons.push("Local terrain gradient too steep");
  }
  if (
    f.distanceToMappedWaterPointM !== undefined &&
    f.distanceToMappedWaterPointM < SERVICE.redundancyRadiusM
  ) {
    reasons.push(
      `Redundant: an existing mapped water point is within ${SERVICE.redundancyRadiusM} m`,
    );
  }

  return reasons;
}

/** Soft penalties that reduce score but do not exclude. */
export function computeWarnings(f: CandidateFeatures): string[] {
  const warnings: string[] = [];

  if (f.distanceToMappedWaterPointM === undefined) {
    warnings.push(
      "No mapped water point found to measure against — redundancy is unverified; absence of mapping is not evidence of absence",
    );
  }
  if (f.floodProxy > WARN.flood) {
    warnings.push(
      "High flood-exposure proxy — seasonal inundation and surface contamination need a site visit",
    );
  }
  if (f.slopeProxy === undefined) {
    warnings.push("No terrain sample near this point — slope treated as neutral");
  } else if (f.slopeProxy > WARN.slope && f.slopeProxy <= MAX_BUILDABLE_SLOPE) {
    warnings.push("Sloping ground — expect additional earthworks and a longer access track");
  }
  if (
    f.distanceToRoadM > SERVICE.maxRoadDistanceM * WARN.roadDistanceFraction &&
    f.distanceToRoadM <= SERVICE.maxRoadDistanceM
  ) {
    warnings.push("Long spur from the nearest mapped road — rig access will add cost");
  }
  if (f.nearbyBuildingCount < WARN.sparseBuildings) {
    warnings.push(
      `Fewer than ${WARN.sparseBuildings} mapped buildings within ${SERVICE.densityRadiusM} m — OpenStreetMap coverage may be incomplete here`,
    );
  }
  if (f.distanceToSchoolM === undefined && f.distanceToClinicM === undefined) {
    warnings.push(
      "No mapped school or clinic nearby — community-facility access could not be verified",
    );
  }
  if (f.evidenceConfidence < WARN.thinEvidence) {
    warnings.push("Thin evidence base for this location — findings are sparse or low-authority");
  }
  if (f.groundwaterEvidenceScore < WARN.weakGroundwater) {
    warnings.push("Weak groundwater evidence — a hydrogeological survey is required before drilling");
  }

  return warnings;
}
