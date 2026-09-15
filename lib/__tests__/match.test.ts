import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { AnalysisRun, InfrastructureRecommendation, Partner, TownRef } from "@/lib/types";
import { matchPartners, resourceNeedFor, type ResourceNeed } from "@/lib/partners/match";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTown(overrides: Partial<TownRef> = {}): TownRef {
  return {
    slug: "kisumu-kenya",
    name: "Kisumu",
    country: "Kenya",
    displayName: "Kisumu, Kenya",
    center: [34.75, -0.1],
    bbox: [34.5, -0.2, 34.9, 0.02],
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<InfrastructureRecommendation> = {}): InfrastructureRecommendation {
  return {
    type: "solar_borehole",
    label: "Solar-powered borehole with storage and tap stands",
    rationale: [],
    components: [],
    cost: {
      lineItems: [],
      subtotalLow: 60_000,
      subtotalHigh: 130_000,
      accessMultiplier: 1,
      accessMultiplierReason: "",
      totalLow: 60_000,
      totalHigh: 130_000,
      currency: "USD",
      assumptions: [],
    },
    output: {
      pumpRateLitersPerHour: 1000,
      effectivePumpingHours: 8,
      operationalEfficiency: 0.8,
      formula: "",
      dailyLitersLow: 5000,
      dailyLitersHigh: 8000,
      litersPerPersonPerDay: 15,
      peopleSupportedLow: 300,
      peopleSupportedHigh: 500,
      caveats: [],
    },
    peopleServedLow: 300,
    peopleServedHigh: 500,
    coverageNote: "",
    maintenanceComplexity: "moderate",
    implementationRangeWeeks: [10, 20],
    confidence: 0.66,
    assumptions: [],
    requiredValidation: [],
    ...overrides,
  };
}

function makeRun(overrides: Partial<AnalysisRun> = {}): AnalysisRun {
  return {
    version: 1,
    town: makeTown(),
    createdAt: Date.now(),
    provenance: "demo",
    events: [],
    osm: {
      roads: [],
      waterways: [],
      buildings: [],
      schools: [],
      clinics: [],
      waterPoints: [],
      hazards: [],
      protectedAreas: [],
      buildingSampleRatio: 1,
      degraded: false,
    },
    climate: {
      annualRainfallMm: 2000,
      monthlyRainfallMmDay: new Array(12).fill(5),
      solarKwhM2Day: 6,
      drySeasonMonths: 0,
      source: "test",
      estimated: false,
    },
    terrain: { samples: [], minM: 1100, maxM: 1200, source: "test", estimated: false },
    findings: [],
    signals: {
      need: 0.5,
      groundwater: 0.5,
      risk: 0.2,
      cost: 0.4,
      access: 0.5,
      quality: 0.5,
      contributors: { need: [], groundwater: [], risk: [], cost: [], access: [] },
    },
    candidates: [],
    candidateCount: 0,
    excludedCount: 0,
    ranked: [],
    winnerId: null,
    population: {
      peopleServed: 400,
      rangeLow: 300,
      rangeHigh: 500,
      serviceRadiusM: 1500,
      method: "building_density_proxy",
      methodLabel: "Building density proxy",
      confidence: 0.5,
      limitations: [],
    },
    recommendation: makeRecommendation(),
    layout: null,
    narrative: "",
    narrativeSource: "deterministic",
    whyThisSite: [],
    alternatives: [],
    dataSources: [],
    warnings: [],
    ...overrides,
  };
}

function makePartner(overrides: Partial<Partner> = {}): Partner {
  return {
    id: "test-partner",
    name: "Test Partner",
    kind: "ngo",
    country: "KE",
    url: "https://example.org",
    description: "",
    focus: ["boreholes", "solar_pumping"],
    source: "verified",
    lastVerified: "2026-09-15",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resourceNeedFor
// ---------------------------------------------------------------------------

describe("resourceNeedFor", () => {
  test("returns null when the run has no recommendation", () => {
    assert.equal(resourceNeedFor(makeRun({ recommendation: null })), null);
  });

  test("derives country, focus and scale from the run", () => {
    const need = resourceNeedFor(makeRun());
    assert.equal(need?.countryIso2, "KE");
    assert.deepEqual(need?.requiredFocus, ["boreholes", "solar_pumping"]);
    assert.equal(need?.scale, "medium"); // totalHigh 130_000 -> medium (50k, 150k breakpoints)
  });

  test("scale tiers follow the documented breakpoints", () => {
    const small = resourceNeedFor(
      makeRun({ recommendation: makeRecommendation({ cost: { ...makeRecommendation().cost, totalHigh: 20_000 } }) }),
    );
    const large = resourceNeedFor(
      makeRun({ recommendation: makeRecommendation({ cost: { ...makeRecommendation().cost, totalHigh: 500_000 } }) }),
    );
    assert.equal(small?.scale, "small");
    assert.equal(large?.scale, "large");
  });
});

// ---------------------------------------------------------------------------
// matchPartners
// ---------------------------------------------------------------------------

describe("matchPartners", () => {
  const need: ResourceNeed = {
    countryIso2: "KE",
    interventionType: "solar_borehole",
    totalCostHighUsd: 130_000,
    scale: "medium",
    requiredFocus: ["boreholes", "solar_pumping"],
    maintenanceComplexity: "moderate",
  };

  test("drops a partner with neither country presence nor focus overlap", () => {
    const irrelevant = makePartner({ id: "irrelevant", country: "BR", focus: ["policy"] });
    assert.deepEqual(matchPartners(need, [irrelevant]), []);
  });

  test("keeps a globally-active partner even without a country-specific match", () => {
    const global = makePartner({ id: "global", country: "global", focus: ["boreholes"] });
    const matches = matchPartners(need, [global]);
    assert.equal(matches.length, 1);
    assert.ok(matches[0].score > 0);
  });

  test("ranks full focus + country + verified match above a partial match", () => {
    const strong = makePartner({ id: "strong", country: "KE", focus: ["boreholes", "solar_pumping"], source: "verified" });
    const partial = makePartner({ id: "partial", country: "global", focus: ["policy"], source: "search" });
    const [first, second] = matchPartners(need, [partial, strong]);
    assert.equal(first.partner.id, "strong");
    assert.equal(second.partner.id, "partial");
    assert.ok(first.score > second.score);
  });

  test("every kept match carries one reason per scoring factor", () => {
    const partner = makePartner();
    const [match] = matchPartners(need, [partner]);
    assert.equal(match.reasons.length, 4);
  });

  test("scores are deterministic for identical input", () => {
    const partner = makePartner();
    const a = matchPartners(need, [partner])[0].score;
    const b = matchPartners(need, [partner])[0].score;
    assert.equal(a, b);
  });
});
