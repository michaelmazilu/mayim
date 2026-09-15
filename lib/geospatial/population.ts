/**
 * Population-served estimation for the winning site.
 *
 * Primary: WorldPop gridded population summed over the service circle and
 * projected to today with the national growth rate. It answers the question
 * directly and does not depend on how completely OpenStreetMap is mapped.
 *
 * Fallback and cross-check: three mapped-data methods, tried in order, each
 * degrading gracefully to the next when its input is missing. When WorldPop
 * answers, the mapped estimate is kept as `alternative` and a large gap between
 * the two is called out rather than averaged away.
 *
 * Every branch reports a range, a human-readable method label and the concrete
 * limitations of that branch — the point is to be honest about how coarse the
 * estimate is, not to produce a confident-looking single number.
 */

import { SERVICE } from "@/lib/config/coefficients";
import type { Rate } from "@/lib/config/behaviour";
import type { CandidateFeatures, OsmData, PopulationEstimate, TownRef } from "@/lib/types";

/**
 * Last-resort catchment band for the facility-density branch, used only when
 * there is neither a geocoder population nor a single mapped building. Reported
 * with low confidence and an explicit limitation.
 */
const PEOPLE_PER_COMMUNITY_FACILITY = {
  low: 250,
  high: 900,
  source: "Demo planning assumption",
};

/** Uncertainty band applied to the population-share branch. */
const SHARE_BAND = 0.3;

const BASE_CONFIDENCE = {
  populationWeighted: 0.7,
  buildingDensity: 0.45,
  facilityDensity: 0.2,
  noBasis: 0.05,
};

/** Multiplier applied when the OSM bundle came back degraded. */
const DEGRADED_CONFIDENCE_FACTOR = 0.75;

/** Extra penalty when the density count had to be extrapolated more than this much. */
const EXTRAPOLATION_PENALTY_THRESHOLD = 2;
const EXTRAPOLATION_PENALTY = 0.08;

function round(v: number): number {
  return Math.max(0, Math.round(v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export type PopulationArgs = {
  town: TownRef;
  osm: OsmData;
  winnerFeatures: CandidateFeatures;
  /** total buildings counted anywhere in the analysis area */
  totalBuildingsInArea: number;
  serviceRadiusM: number;
};

/** Methods 1–3: geocoder population by building share, building density, facility density. */
export function estimateFromMappedData(args: PopulationArgs): PopulationEstimate {
  const { town, osm, winnerFeatures, totalBuildingsInArea } = args;
  const serviceRadiusM =
    args.serviceRadiusM > 0 ? Math.round(args.serviceRadiusM) : SERVICE.walkingRadiusM;

  // Candidate features count neighbours inside SERVICE.densityRadiusM, so the
  // service-radius count is scaled by the area ratio between the two circles.
  const areaRatio = (serviceRadiusM / SERVICE.densityRadiusM) ** 2;
  const buildingsInRadius = Math.min(
    Math.round(winnerFeatures.nearbyBuildingCount * areaRatio),
    Math.max(totalBuildingsInArea, 0),
  );
  const facilitiesInRadius = Math.round(
    winnerFeatures.nearbyCommunityFacilityCount * areaRatio,
  );

  const degradedFactor = osm.degraded ? DEGRADED_CONFIDENCE_FACTOR : 1;
  const extrapolationPenalty =
    areaRatio > EXTRAPOLATION_PENALTY_THRESHOLD ? EXTRAPOLATION_PENALTY : 0;

  const sharedLimitations = [
    `Neighbour counts are measured within ${SERVICE.densityRadiusM} m of the site and scaled by area to the ${serviceRadiusM} m service radius; real settlement is not uniform.`,
    "Everyone inside the service radius is assumed to be able and willing to walk to the point; terrain, land tenure and social barriers are not modelled.",
  ];
  if (osm.degraded) {
    sharedLimitations.push(
      "The OpenStreetMap extract came back degraded, so mapped features are incomplete and counts are understated.",
    );
  }

  const hint = town.populationHint;
  const hasHint = typeof hint === "number" && Number.isFinite(hint) && hint > 0;

  // (1) Geocoder population distributed by the site's share of mapped buildings.
  if (hasHint && totalBuildingsInArea > 0 && buildingsInRadius > 0) {
    const share = Math.min(buildingsInRadius / totalBuildingsInArea, 1);
    const peopleServed = round(hint * share);
    const yearNote = town.populationHintYear ? ` (${town.populationHintYear})` : "";
    const sourceNote = town.populationHintSource ? `, ${town.populationHintSource}` : "";
    return {
      peopleServed,
      rangeLow: round(peopleServed * (1 - SHARE_BAND)),
      rangeHigh: Math.min(round(peopleServed * (1 + SHARE_BAND)), round(hint)),
      serviceRadiusM,
      method: "geocoder_population_building_weighted",
      methodLabel: `${Math.round(hint).toLocaleString("en-US")} reported residents of ${town.name}${yearNote}${sourceNote}, split by this site's share of mapped buildings (${buildingsInRadius.toLocaleString("en-US")} of ${totalBuildingsInArea.toLocaleString("en-US")} in the analysis area).`,
      confidence: round2(
        Math.max(
          0,
          BASE_CONFIDENCE.populationWeighted * degradedFactor - extrapolationPenalty,
        ),
      ),
      limitations: [
        `The published population figure covers the whole of ${town.displayName}; distributing it by building count assumes household size is uniform across the settlement.`,
        "OpenStreetMap building coverage is uneven, so a well-mapped neighbourhood is credited with a larger share than a poorly mapped one of the same size.",
        ...sharedLimitations,
      ],
    };
  }

  // (2) No population figure, but buildings are mapped: household-size band.
  //
  // Overpass caps the building layer, so `buildingsInRadius` counts the SAMPLE,
  // not the settlement. Method (1) above is a ratio and therefore unaffected,
  // but this branch is absolute and must be scaled back up or a capped city
  // reads as a hamlet.
  if (buildingsInRadius > 0) {
    const sampleRatio = Number.isFinite(osm.buildingSampleRatio)
      ? Math.max(1, osm.buildingSampleRatio)
      : 1;
    const scaledBuildings = buildingsInRadius * sampleRatio;
    const low = scaledBuildings * SERVICE.peoplePerBuilding.low;
    const high = scaledBuildings * SERVICE.peoplePerBuilding.high;
    return {
      peopleServed: round((low + high) / 2),
      rangeLow: round(low),
      rangeHigh: round(high),
      serviceRadiusM,
      method: "building_density_proxy",
      methodLabel:
        sampleRatio > 1
          ? `${buildingsInRadius.toLocaleString("en-US")} mapped buildings within ${serviceRadiusM} m, scaled by ${sampleRatio.toFixed(1)}x because OpenStreetMap returned more footprints than the analysis retains, at ${SERVICE.peoplePerBuilding.low}-${SERVICE.peoplePerBuilding.high} people per building (${SERVICE.peoplePerBuilding.source}).`
          : `${buildingsInRadius.toLocaleString("en-US")} mapped buildings within ${serviceRadiusM} m, at ${SERVICE.peoplePerBuilding.low}-${SERVICE.peoplePerBuilding.high} people per building (${SERVICE.peoplePerBuilding.source}).`,
      confidence: round2(
        Math.max(0, BASE_CONFIDENCE.buildingDensity * degradedFactor - extrapolationPenalty),
      ),
      limitations: [
        `No population figure was available for ${town.displayName}, so the estimate rests entirely on building count.`,
        "Every mapped building is treated as an occupied dwelling; sheds, shops and institutional buildings inflate the count.",
        ...(sampleRatio > 1
          ? [
              `Building footprints were subsampled ${sampleRatio.toFixed(1)}x for performance and scaled back up, which assumes the sample is spatially even.`,
            ]
          : []),
        ...sharedLimitations,
      ],
    };
  }

  // (3) Nothing but community facilities to go on.
  if (facilitiesInRadius > 0) {
    const low = facilitiesInRadius * PEOPLE_PER_COMMUNITY_FACILITY.low;
    const high = facilitiesInRadius * PEOPLE_PER_COMMUNITY_FACILITY.high;
    return {
      peopleServed: round((low + high) / 2),
      rangeLow: round(low),
      rangeHigh: round(high),
      serviceRadiusM,
      method: "facility_density_proxy",
      methodLabel: `${facilitiesInRadius} mapped school(s) and clinic(s) within ${serviceRadiusM} m, at ${PEOPLE_PER_COMMUNITY_FACILITY.low}-${PEOPLE_PER_COMMUNITY_FACILITY.high} people per facility catchment (${PEOPLE_PER_COMMUNITY_FACILITY.source}).`,
      confidence: round2(Math.max(0, BASE_CONFIDENCE.facilityDensity * degradedFactor)),
      limitations: [
        "No population figure and no mapped buildings were available, so this is an order-of-magnitude placeholder rather than an estimate.",
        "Facility catchments vary by an order of magnitude between a one-room clinic and a district school; the band reflects that, the midpoint should not be quoted alone.",
        "A field enumeration or a household survey is required before this figure is used for anything.",
        ...sharedLimitations,
      ],
    };
  }

  // Nothing at all. Report zero rather than inventing a number.
  return {
    peopleServed: 0,
    rangeLow: 0,
    rangeHigh: 0,
    serviceRadiusM,
    method: "facility_density_proxy",
    methodLabel: `No population figure, mapped buildings or community facilities were found within ${serviceRadiusM} m of the site, so no population could be estimated.`,
    confidence: round2(BASE_CONFIDENCE.noBasis),
    limitations: [
      `${town.displayName} returned no geocoder population figure.`,
      "No buildings, schools or clinics are mapped near the site in OpenStreetMap; absence of mapping is not evidence of absence of people.",
      "Ground truthing is required before this site is taken any further.",
      ...sharedLimitations,
    ],
  };
}

// ---------------------------------------------------------------------------
// Primary: WorldPop
// ---------------------------------------------------------------------------

/**
 * The WorldPop stats API returns a single total with no per-area uncertainty,
 * so Mayim applies this screening band around the projected figure.
 */
const WORLDPOP_BAND = { value: 0.2, source: "Mayim screening assumption" };
const WORLDPOP_CONFIDENCE = 0.6;

/** Gridded and mapped estimates further apart than this factor are flagged. */
export const DISAGREEMENT_FACTOR = 2;

export type WorldPopCount = NonNullable<PopulationEstimate["worldpop"]>;

/**
 * How many times apart the WorldPop and mapped-data estimates are, when that
 * exceeds DISAGREEMENT_FACTOR. Null when they agree or there is nothing to compare.
 */
export function populationDisagreement(p: PopulationEstimate): number | null {
  if (p.method !== "worldpop_gridded" || !p.alternative) return null;
  const mapped = (p.alternative.rangeLow + p.alternative.rangeHigh) / 2;
  const gridded = p.peopleServed;
  if (!(mapped > 0) || !(gridded > 0)) return null;
  const factor = Math.max(mapped / gridded, gridded / mapped);
  return factor > DISAGREEMENT_FACTOR ? Math.round(factor * 10) / 10 : null;
}

export function estimatePopulationServed(
  args: PopulationArgs & {
    /** WorldPop count for the service circle; null/absent falls back to mapped data. */
    worldpop?: WorldPopCount | null;
    /** National growth rate used to project the WorldPop year forward. */
    growth?: Pick<Rate, "low" | "central" | "high" | "source">;
    /** Year to project to; defaults to the WorldPop year (no projection). */
    asOfYear?: number;
  },
): PopulationEstimate {
  const mapped = estimateFromMappedData(args);
  const wp = args.worldpop;
  if (!wp || !Number.isFinite(wp.people) || wp.people < 0) return mapped;

  const g = args.growth;
  const years = g ? Math.max(0, (args.asOfYear ?? wp.year) - wp.year) : 0;
  const project = (pct: number) => wp.people * (1 + pct / 100) ** years;
  const central = project(g?.central ?? 0);
  const low = project(g?.low ?? 0) * (1 - WORLDPOP_BAND.value);
  const high = project(g?.high ?? 0) * (1 + WORLDPOP_BAND.value);

  const radius = mapped.serviceRadiusM;
  const projection =
    years > 0 && g
      ? `, projected ${years} years to ${args.asOfYear} at ${g.low}–${g.high}%/yr (${g.source})`
      : "";
  const estimate: PopulationEstimate = {
    peopleServed: round(central),
    rangeLow: round(low),
    rangeHigh: round(high),
    serviceRadiusM: radius,
    method: "worldpop_gridded",
    methodLabel:
      `${Math.round(wp.people).toLocaleString("en-US")} people inside the ${radius.toLocaleString("en-US")} m service circle ` +
      `per ${wp.source}${projection}. Range adds a ±${WORLDPOP_BAND.value * 100}% band (${WORLDPOP_BAND.source}).`,
    confidence: WORLDPOP_CONFIDENCE,
    limitations: [
      ...(years > 0
        ? [`WorldPop's latest global year is ${wp.year}; growth since then is projected with the national rate, not observed.`]
        : []),
      "WorldPop is a modelled distribution of census totals, not a count; the unconstrained model can place people on unbuilt land.",
      "100 m grid cells on the edge of the service circle are approximated.",
      "Everyone inside the service radius is assumed to be able and willing to walk to the point; terrain, land tenure and social barriers are not modelled.",
    ],
    worldpop: wp,
    alternative: {
      method: mapped.method as NonNullable<PopulationEstimate["alternative"]>["method"],
      rangeLow: mapped.rangeLow,
      rangeHigh: mapped.rangeHigh,
      methodLabel: mapped.methodLabel,
    },
  };

  const factor = populationDisagreement(estimate);
  if (factor) {
    estimate.limitations.push(
      `The mapped-building estimate (${mapped.rangeLow.toLocaleString("en-US")}–${mapped.rangeHigh.toLocaleString("en-US")}) differs by ${factor}×; treat the two as bounds until a household count is done.`,
    );
  }
  return estimate;
}
