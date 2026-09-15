import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  Candidate,
  CandidateFeatures,
  CandidateScore,
  EvidenceSignals,
  ScoreBreakdown,
} from "@/lib/types";
import { SERVICE, WEIGHTS } from "@/lib/config/coefficients";
import { clamp01, forwardNormalize, inverseNormalize, saturate } from "@/lib/scoring/normalize";
import { computeExclusions, computeWarnings } from "@/lib/scoring/exclusions";
import { rankCandidates, scoreCandidate, type ScoringContext } from "@/lib/scoring/score";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid, fully-surviving candidate. Every field is overridable. */
function makeFeatures(overrides: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    distanceToRoadM: 220,
    distanceToWaterwayM: 500,
    distanceToSchoolM: 600,
    distanceToClinicM: 900,
    distanceToMappedWaterPointM: 1400,
    nearbyBuildingCount: 180,
    nearbyCommunityFacilityCount: 3,
    elevationM: 1150,
    slopeProxy: 0.2,
    nearWasteOrIndustrialSite: false,
    insideProtectedArea: false,
    floodProxy: 0.3,
    groundwaterEvidenceScore: 0.62,
    evidenceConfidence: 0.7,
    ...overrides,
  };
}

function makeSignals(overrides: Partial<EvidenceSignals> = {}): EvidenceSignals {
  return {
    need: 0.7,
    groundwater: 0.55,
    risk: 0.25,
    cost: 0.4,
    access: 0.35,
    quality: 0.6,
    contributors: {
      need: ["f-need-2", "f-need-1"],
      groundwater: ["f-gw-1", "f-need-1"],
      risk: ["f-risk-1"],
      cost: ["f-cost-1"],
      access: ["f-access-1"],
    },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    signals: makeSignals(),
    maxNearbyBuildings: 400,
    maxNearbyFacilities: 8,
    ...overrides,
  };
}

function makeCandidate(
  id: string,
  overall: number,
  opts: { excluded?: boolean; exclusions?: string[] } = {},
): Candidate {
  const breakdown: ScoreBreakdown = {
    communityNeed: 0,
    populationAccessProxy: 0,
    groundwaterFeasibility: 0,
    roadAndConstructionAccess: 0,
    distanceFromExistingService: 0,
    environmentalSafety: 0,
    evidenceQuality: 0,
  };
  const exclusions = opts.exclusions ?? [];
  return {
    id,
    lon: 34.75,
    lat: -0.09,
    features: makeFeatures(),
    score: { overall, breakdown, exclusions, warnings: [], supportingEvidenceIds: [] },
    excluded: opts.excluded ?? exclusions.length > 0,
  };
}

const BREAKDOWN_KEYS = Object.keys(WEIGHTS) as (keyof ScoreBreakdown)[];

function assertUnitRange(score: CandidateScore, label: string): void {
  for (const key of BREAKDOWN_KEYS) {
    const v = score.breakdown[key];
    assert.ok(Number.isFinite(v), `${label}: ${key} is not finite (${v})`);
    assert.ok(v >= 0 && v <= 1, `${label}: ${key} outside [0,1] (${v})`);
  }
  assert.ok(Number.isFinite(score.overall), `${label}: overall is not finite`);
  assert.ok(score.overall >= 0 && score.overall <= 1, `${label}: overall outside [0,1]`);
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

describe("clamp01", () => {
  test("passes through in-range values", () => {
    assert.equal(clamp01(0.5), 0.5);
    assert.equal(clamp01(0), 0);
    assert.equal(clamp01(1), 1);
  });

  test("clamps out-of-range values", () => {
    assert.equal(clamp01(-0.0001), 0);
    assert.equal(clamp01(-1e9), 0);
    assert.equal(clamp01(1.0001), 1);
    assert.equal(clamp01(Number.POSITIVE_INFINITY), 1);
    assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
  });

  test("maps NaN to 0 and never yields -0", () => {
    assert.equal(clamp01(Number.NaN), 0);
    assert.ok(Object.is(clamp01(-0), 0));
  });
});

describe("inverseNormalize", () => {
  test("is 1 at or below best and 0 at or above worst", () => {
    assert.equal(inverseNormalize(200, 200, 1000), 1);
    assert.equal(inverseNormalize(0, 200, 1000), 1);
    assert.equal(inverseNormalize(-50, 200, 1000), 1);
    assert.equal(inverseNormalize(1000, 200, 1000), 0);
    assert.equal(inverseNormalize(5000, 200, 1000), 0);
  });

  test("interpolates linearly inside the range", () => {
    assert.equal(inverseNormalize(600, 200, 1000), 0.5);
    assert.equal(inverseNormalize(400, 200, 1000), 0.75);
  });

  test("decreases monotonically and stays in [0,1]", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let raw = -200; raw <= 1400; raw += 50) {
      const v = inverseNormalize(raw, 200, 1000);
      assert.ok(v >= 0 && v <= 1, `out of range at ${raw}`);
      assert.ok(v <= previous, `not monotonic at ${raw}`);
      previous = v;
    }
  });

  test("handles a degenerate range and NaN", () => {
    assert.equal(inverseNormalize(500, 1000, 1000), 1);
    assert.equal(inverseNormalize(1500, 1000, 1000), 0);
    assert.equal(inverseNormalize(Number.NaN, 200, 1000), 0);
  });
});

describe("forwardNormalize", () => {
  test("is 0 at or below worst and 1 at or above best", () => {
    assert.equal(forwardNormalize(350, 350, 2500), 0);
    assert.equal(forwardNormalize(0, 350, 2500), 0);
    assert.equal(forwardNormalize(2500, 350, 2500), 1);
    assert.equal(forwardNormalize(9999, 350, 2500), 1);
  });

  test("interpolates linearly inside the range", () => {
    assert.equal(forwardNormalize(1425, 350, 2500), 0.5);
    assert.equal(forwardNormalize(887.5, 350, 2500), 0.25);
  });

  test("increases monotonically and stays in [0,1]", () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let raw = -500; raw <= 3000; raw += 100) {
      const v = forwardNormalize(raw, 350, 2500);
      assert.ok(v >= 0 && v <= 1, `out of range at ${raw}`);
      assert.ok(v >= previous, `not monotonic at ${raw}`);
      previous = v;
    }
  });

  test("handles a degenerate range and NaN", () => {
    assert.equal(forwardNormalize(500, 1000, 1000), 0);
    assert.equal(forwardNormalize(1500, 1000, 1000), 1);
    assert.equal(forwardNormalize(Number.NaN, 350, 2500), 0);
  });
});

describe("saturate", () => {
  test("scores ~0.86 at the saturation point", () => {
    const v = saturate(120, 120);
    assert.ok(Math.abs(v - 0.86) < 0.01, `expected ~0.86, got ${v}`);
  });

  test("is 0 at or below zero and approaches 1 above", () => {
    assert.equal(saturate(0, 120), 0);
    assert.equal(saturate(-40, 120), 0);
    assert.ok(saturate(1000, 120) > 0.99);
    assert.ok(saturate(1e9, 120) <= 1);
    assert.equal(saturate(Number.POSITIVE_INFINITY, 120), 1);
    assert.equal(saturate(Number.NaN, 120), 0);
  });

  test("increases monotonically with diminishing returns", () => {
    let previous = -1;
    for (let raw = 0; raw <= 600; raw += 20) {
      const v = saturate(raw, 120);
      assert.ok(v >= 0 && v <= 1, `out of range at ${raw}`);
      assert.ok(v >= previous, `not monotonic at ${raw}`);
      previous = v;
    }
    // Second 120 units add less than the first 120 units.
    const firstStep = saturate(120, 120) - saturate(0, 120);
    const secondStep = saturate(240, 120) - saturate(120, 120);
    assert.ok(secondStep < firstStep);
  });

  test("handles degenerate saturation values", () => {
    assert.equal(saturate(5, 0), 1);
    assert.equal(saturate(5, -10), 1);
    assert.equal(saturate(5, Number.POSITIVE_INFINITY), 0);
    assert.equal(saturate(5, Number.NaN), 0);
  });
});

// ---------------------------------------------------------------------------
// exclusions
// ---------------------------------------------------------------------------

describe("computeExclusions", () => {
  const PROTECTED = "Inside a mapped protected area";
  const HAZARD = `Within ${SERVICE.hazardBufferM} m of a mapped waste or industrial site`;
  const WATERWAY = "Within the mapped waterway channel";
  const ROAD = "Beyond practical construction access from a mapped road";
  const SLOPE = "Local terrain gradient too steep";
  const REDUNDANT = `Redundant: an existing mapped water point is within ${SERVICE.redundancyRadiusM} m`;
  const ALL = [PROTECTED, HAZARD, WATERWAY, ROAD, SLOPE, REDUNDANT];

  test("a healthy candidate is not excluded", () => {
    assert.deepEqual(computeExclusions(makeFeatures()), []);
  });

  test("protected area fires only on its trigger", () => {
    assert.deepEqual(computeExclusions(makeFeatures({ insideProtectedArea: true })), [PROTECTED]);
    assert.ok(!computeExclusions(makeFeatures({ insideProtectedArea: false })).includes(PROTECTED));
  });

  test("waste/industrial proximity fires only on its trigger", () => {
    assert.deepEqual(computeExclusions(makeFeatures({ nearWasteOrIndustrialSite: true })), [HAZARD]);
    assert.ok(!computeExclusions(makeFeatures()).includes(HAZARD));
  });

  test("waterway buffer fires strictly below the buffer", () => {
    assert.deepEqual(
      computeExclusions(makeFeatures({ distanceToWaterwayM: SERVICE.waterwayBufferM - 1 })),
      [WATERWAY],
    );
    assert.deepEqual(
      computeExclusions(makeFeatures({ distanceToWaterwayM: SERVICE.waterwayBufferM })),
      [],
    );
  });

  test("road access fires strictly beyond the max distance", () => {
    assert.deepEqual(
      computeExclusions(makeFeatures({ distanceToRoadM: SERVICE.maxRoadDistanceM + 1 })),
      [ROAD],
    );
    assert.deepEqual(
      computeExclusions(makeFeatures({ distanceToRoadM: SERVICE.maxRoadDistanceM })),
      [],
    );
  });

  test("slope fires above 0.85 only, and never when unknown", () => {
    assert.deepEqual(computeExclusions(makeFeatures({ slopeProxy: 0.86 })), [SLOPE]);
    assert.deepEqual(computeExclusions(makeFeatures({ slopeProxy: 0.85 })), []);
    assert.deepEqual(computeExclusions(makeFeatures({ slopeProxy: undefined })), []);
  });

  test("redundancy fires strictly inside the radius, and never when unknown", () => {
    assert.deepEqual(
      computeExclusions(
        makeFeatures({ distanceToMappedWaterPointM: SERVICE.redundancyRadiusM - 1 }),
      ),
      [REDUNDANT],
    );
    assert.deepEqual(
      computeExclusions(makeFeatures({ distanceToMappedWaterPointM: SERVICE.redundancyRadiusM })),
      [],
    );
    assert.deepEqual(
      computeExclusions(makeFeatures({ distanceToMappedWaterPointM: undefined })),
      [],
    );
  });

  test("all six rules can fire at once, in a stable order", () => {
    const reasons = computeExclusions(
      makeFeatures({
        insideProtectedArea: true,
        nearWasteOrIndustrialSite: true,
        distanceToWaterwayM: 0,
        distanceToRoadM: SERVICE.maxRoadDistanceM + 500,
        slopeProxy: 0.99,
        distanceToMappedWaterPointM: 10,
      }),
    );
    assert.deepEqual(reasons, ALL);
  });
});

describe("computeWarnings", () => {
  test("a healthy candidate warns about nothing", () => {
    assert.deepEqual(computeWarnings(makeFeatures()), []);
  });

  test("an unmapped water-point layer produces a warning", () => {
    const warnings = computeWarnings(makeFeatures({ distanceToMappedWaterPointM: undefined }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /absence of mapping is not evidence of absence/);
  });

  test("soft thresholds warn without excluding", () => {
    const f = makeFeatures({
      floodProxy: 0.8,
      slopeProxy: 0.7,
      nearbyBuildingCount: 4,
      evidenceConfidence: 0.1,
      groundwaterEvidenceScore: 0.05,
      distanceToSchoolM: undefined,
      distanceToClinicM: undefined,
    });
    assert.deepEqual(computeExclusions(f), []);
    assert.equal(computeWarnings(f).length, 6);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate
// ---------------------------------------------------------------------------

describe("scoreCandidate", () => {
  test("stays in [0,1] for a normal candidate", () => {
    assertUnitRange(scoreCandidate(makeFeatures(), makeCtx()), "baseline");
  });

  test("stays in [0,1] for all-zero features and zero signals", () => {
    const zeroFeatures: CandidateFeatures = {
      distanceToRoadM: 0,
      distanceToWaterwayM: 0,
      distanceToSchoolM: 0,
      distanceToClinicM: 0,
      distanceToMappedWaterPointM: 0,
      nearbyBuildingCount: 0,
      nearbyCommunityFacilityCount: 0,
      elevationM: 0,
      slopeProxy: 0,
      nearWasteOrIndustrialSite: false,
      insideProtectedArea: false,
      floodProxy: 0,
      groundwaterEvidenceScore: 0,
      evidenceConfidence: 0,
    };
    const zeroSignals = makeSignals({
      need: 0,
      groundwater: 0,
      risk: 0,
      cost: 0,
      access: 0,
      quality: 0,
    });
    assertUnitRange(
      scoreCandidate(
        zeroFeatures,
        makeCtx({ signals: zeroSignals, maxNearbyBuildings: 1, maxNearbyFacilities: 1 }),
      ),
      "all zeros",
    );
  });

  test("stays in [0,1] for huge features and saturated signals", () => {
    const hugeFeatures = makeFeatures({
      distanceToRoadM: 1e9,
      distanceToWaterwayM: 1e9,
      distanceToSchoolM: 1e9,
      distanceToClinicM: 1e9,
      distanceToMappedWaterPointM: 1e9,
      nearbyBuildingCount: 1e6,
      nearbyCommunityFacilityCount: 1e6,
      elevationM: 1e5,
      slopeProxy: 1,
      floodProxy: 1,
      groundwaterEvidenceScore: 1,
      evidenceConfidence: 1,
    });
    const maxSignals = makeSignals({
      need: 1,
      groundwater: 1,
      risk: 1,
      cost: 1,
      access: 1,
      quality: 1,
    });
    assertUnitRange(scoreCandidate(hugeFeatures, makeCtx({ signals: maxSignals })), "all huge");
  });

  test("stays in [0,1] for out-of-contract values (negative, >1, degenerate context)", () => {
    const wild = makeFeatures({
      distanceToRoadM: -100,
      distanceToWaterwayM: -100,
      distanceToSchoolM: -100,
      distanceToClinicM: -100,
      distanceToMappedWaterPointM: -100,
      nearbyBuildingCount: -50,
      nearbyCommunityFacilityCount: -50,
      slopeProxy: 3,
      floodProxy: -2,
      groundwaterEvidenceScore: 5,
      evidenceConfidence: -5,
    });
    const wildSignals = makeSignals({ need: 4, risk: -3, access: 9, quality: -1 });
    assertUnitRange(
      scoreCandidate(
        wild,
        makeCtx({ signals: wildSignals, maxNearbyBuildings: 0, maxNearbyFacilities: 0 }),
      ),
      "out of contract",
    );
  });

  test("stays in [0,1] when every optional feature is missing", () => {
    const sparse = makeFeatures({
      distanceToSchoolM: undefined,
      distanceToClinicM: undefined,
      distanceToMappedWaterPointM: undefined,
      elevationM: undefined,
      slopeProxy: undefined,
    });
    assertUnitRange(scoreCandidate(sparse, makeCtx()), "sparse");
  });

  test("overall is exactly the weighted sum of the reported breakdown", () => {
    const score = scoreCandidate(makeFeatures(), makeCtx());
    const expected =
      Math.round(
        BREAKDOWN_KEYS.reduce((sum, key) => sum + score.breakdown[key] * WEIGHTS[key], 0) * 1e4,
      ) / 1e4;
    assert.equal(score.overall, expected);
  });

  test("every reported value is rounded to 4 decimals", () => {
    const score = scoreCandidate(makeFeatures({ groundwaterEvidenceScore: 0.123456789 }), makeCtx());
    for (const key of BREAKDOWN_KEYS) {
      assert.equal(score.breakdown[key], Math.round(score.breakdown[key] * 1e4) / 1e4);
    }
    assert.equal(score.overall, Math.round(score.overall * 1e4) / 1e4);
  });

  test("an excluded candidate scores exactly 0 for every exclusion rule", () => {
    const triggers: Partial<CandidateFeatures>[] = [
      { insideProtectedArea: true },
      { nearWasteOrIndustrialSite: true },
      { distanceToWaterwayM: SERVICE.waterwayBufferM - 1 },
      { distanceToRoadM: SERVICE.maxRoadDistanceM + 1 },
      { slopeProxy: 0.9 },
      { distanceToMappedWaterPointM: SERVICE.redundancyRadiusM - 1 },
    ];
    for (const trigger of triggers) {
      const score = scoreCandidate(makeFeatures(trigger), makeCtx());
      assert.ok(score.exclusions.length > 0, `expected exclusion for ${JSON.stringify(trigger)}`);
      assert.equal(score.overall, 0, `expected 0 for ${JSON.stringify(trigger)}`);
      assertUnitRange(score, `excluded ${JSON.stringify(trigger)}`);
    }
  });

  test("a surviving candidate scores above 0", () => {
    const score = scoreCandidate(makeFeatures(), makeCtx());
    assert.deepEqual(score.exclusions, []);
    assert.ok(score.overall > 0);
  });

  test("an unmapped water-point layer uses 0.65 and warns rather than claiming 1.0", () => {
    const score = scoreCandidate(makeFeatures({ distanceToMappedWaterPointM: undefined }), makeCtx());
    assert.equal(score.breakdown.distanceFromExistingService, 0.65);
    assert.ok(score.warnings.some((w) => /absence of mapping is not evidence of absence/.test(w)));
  });

  test("hard environmental flags drive environmentalSafety low", () => {
    const ctx = makeCtx();
    const clean = scoreCandidate(makeFeatures(), ctx);
    const flagged = scoreCandidate(makeFeatures({ insideProtectedArea: true }), ctx);
    const hazard = scoreCandidate(makeFeatures({ nearWasteOrIndustrialSite: true }), ctx);
    assert.ok(clean.breakdown.environmentalSafety > 0.5);
    assert.ok(flagged.breakdown.environmentalSafety <= 0.05);
    assert.ok(hazard.breakdown.environmentalSafety <= 0.05);
  });

  test("a moderate flood proxy beats both extremes for groundwater feasibility", () => {
    const ctx = makeCtx();
    const dry = scoreCandidate(makeFeatures({ floodProxy: 0 }), ctx);
    const moderate = scoreCandidate(makeFeatures({ floodProxy: 0.45 }), ctx);
    const soaked = scoreCandidate(makeFeatures({ floodProxy: 1 }), ctx);
    assert.ok(moderate.breakdown.groundwaterFeasibility > dry.breakdown.groundwaterFeasibility);
    assert.ok(moderate.breakdown.groundwaterFeasibility > soaked.breakdown.groundwaterFeasibility);
    // ...but a soaked site must still lose overall, via environmental safety.
    assert.ok(soaked.breakdown.environmentalSafety < dry.breakdown.environmentalSafety);
    assert.ok(soaked.overall < moderate.overall);
  });

  test("denser and better-connected sites score at least as high", () => {
    const ctx = makeCtx();
    const sparse = scoreCandidate(makeFeatures({ nearbyBuildingCount: 20 }), ctx);
    const dense = scoreCandidate(makeFeatures({ nearbyBuildingCount: 300 }), ctx);
    assert.ok(dense.breakdown.communityNeed > sparse.breakdown.communityNeed);
    assert.ok(dense.breakdown.populationAccessProxy > sparse.breakdown.populationAccessProxy);

    const far = scoreCandidate(makeFeatures({ distanceToRoadM: 1100 }), ctx);
    const near = scoreCandidate(makeFeatures({ distanceToRoadM: 60 }), ctx);
    assert.ok(near.breakdown.roadAndConstructionAccess > far.breakdown.roadAndConstructionAccess);
  });

  test("supporting evidence ids are deduplicated and sorted", () => {
    const score = scoreCandidate(makeFeatures(), makeCtx());
    assert.deepEqual(score.supportingEvidenceIds, [
      "f-access-1",
      "f-gw-1",
      "f-need-1",
      "f-need-2",
      "f-risk-1",
    ]);
    // Cost is never a scoring factor here, so its findings are not cited.
    assert.ok(!score.supportingEvidenceIds.includes("f-cost-1"));
  });

  test("immaterial signals are not cited as supporting evidence", () => {
    const signals = makeSignals({ need: 0, risk: 0, access: 0 });
    const score = scoreCandidate(
      makeFeatures({ groundwaterEvidenceScore: 0 }),
      makeCtx({ signals }),
    );
    assert.deepEqual(score.supportingEvidenceIds, []);
  });

  test("is deterministic: identical inputs give identical output", () => {
    const ctx = makeCtx();
    const a = scoreCandidate(makeFeatures(), ctx);
    const b = scoreCandidate(makeFeatures(), ctx);
    assert.deepStrictEqual(a, b);
    assert.equal(a.overall, b.overall);

    // Re-running against a freshly constructed but equal context also matches.
    const c = scoreCandidate(makeFeatures(), makeCtx());
    assert.deepStrictEqual(a, c);
  });

  test("does not mutate its inputs", () => {
    const features = makeFeatures();
    const ctx = makeCtx();
    const featuresSnapshot = structuredClone(features);
    const ctxSnapshot = structuredClone(ctx);
    scoreCandidate(features, ctx);
    assert.deepStrictEqual(features, featuresSnapshot);
    assert.deepStrictEqual(ctx, ctxSnapshot);
  });
});

// ---------------------------------------------------------------------------
// rankCandidates
// ---------------------------------------------------------------------------

describe("rankCandidates", () => {
  test("orders by overall descending and drops excluded candidates", () => {
    const ranked = rankCandidates([
      makeCandidate("c-1", 0.42),
      makeCandidate("c-2", 0.91),
      makeCandidate("c-3", 0, { exclusions: ["Inside a mapped protected area"] }),
      makeCandidate("c-4", 0.67),
      makeCandidate("c-5", 0.88, { excluded: true }),
    ]);
    assert.deepEqual(ranked, ["c-2", "c-4", "c-1"]);
  });

  test("breaks ties by id ascending", () => {
    const ranked = rankCandidates([
      makeCandidate("c-9", 0.5),
      makeCandidate("c-1", 0.5),
      makeCandidate("c-3", 0.5),
    ]);
    assert.deepEqual(ranked, ["c-1", "c-3", "c-9"]);
  });

  test("is order-independent when scores tie", () => {
    const ids = ["c-4", "c-2", "c-7", "c-1", "c-3"];
    const forward = rankCandidates(ids.map((id) => makeCandidate(id, 0.5)));
    const reversed = rankCandidates([...ids].reverse().map((id) => makeCandidate(id, 0.5)));
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward, ["c-1", "c-2", "c-3", "c-4", "c-7"]);
  });

  test("repeated calls return the same ordering", () => {
    const candidates = [
      makeCandidate("b", 0.5),
      makeCandidate("a", 0.5),
      makeCandidate("c", 0.75),
      makeCandidate("d", 0.1),
    ];
    assert.deepEqual(rankCandidates(candidates), rankCandidates(candidates));
    assert.deepEqual(rankCandidates(candidates), ["c", "a", "b", "d"]);
  });

  test("returns an empty list when everything is excluded", () => {
    const ranked = rankCandidates([
      makeCandidate("c-1", 0, { exclusions: ["Within the mapped waterway channel"] }),
      makeCandidate("c-2", 0.9, { excluded: true }),
    ]);
    assert.deepEqual(ranked, []);
  });

  test("handles an empty input", () => {
    assert.deepEqual(rankCandidates([]), []);
  });

  test("ranks real scored candidates deterministically", () => {
    const ctx = makeCtx();
    const specs: { id: string; features: CandidateFeatures }[] = [
      { id: "s-3", features: makeFeatures({ nearbyBuildingCount: 40, distanceToRoadM: 900 }) },
      { id: "s-1", features: makeFeatures({ nearbyBuildingCount: 380, distanceToRoadM: 80 }) },
      { id: "s-2", features: makeFeatures({ insideProtectedArea: true }) },
    ];
    const build = (): Candidate[] =>
      specs.map(({ id, features }) => {
        const score = scoreCandidate(features, ctx);
        return { id, lon: 34.75, lat: -0.09, features, score, excluded: score.exclusions.length > 0 };
      });

    const first = rankCandidates(build());
    const second = rankCandidates(build().reverse());
    assert.deepEqual(first, second);
    assert.deepEqual(first, ["s-1", "s-3"]);
  });
});
