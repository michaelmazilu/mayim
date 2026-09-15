/**
 * Unit tests for the cost, water-output and infrastructure-selection models.
 *
 * Run with a TypeScript-aware runner, e.g.:
 *   npx tsx --test lib/__tests__/models.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import type {
  CandidateFeatures,
  ClimateData,
  InfrastructureType,
  PopulationEstimate,
} from "@/lib/types";
import { computeAccessMultiplier, estimateCost, type CostInput } from "@/lib/cost-model/cost";
import { estimateOutput, type OutputInput } from "@/lib/water-output/output";
import {
  buildRecommendation,
  selectInfrastructureType,
  type SelectionInput,
} from "@/lib/infrastructure/select";

const ALL_TYPES: InfrastructureType[] = [
  "solar_borehole",
  "borehole_rehabilitation",
  "rainwater_harvesting",
  "filtration_and_storage",
  "community_storage_and_taps",
];

const LITERS_PER_PERSON_PER_DAY = 20;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function costInput(overrides: Partial<CostInput> = {}): CostInput {
  return {
    groundwaterConfidence: 0.6,
    distanceToRoadM: 320,
    slopeProxy: 0.25,
    peopleServed: 850,
    pipelineLengthM: 620,
    tapStandCount: 4,
    solarArrayWp: 700,
    tankVolumeLiters: 17000,
    ...overrides,
  };
}

function outputInput(overrides: Partial<OutputInput> = {}): OutputInput {
  return {
    solarKwhM2Day: 5,
    groundwaterConfidence: 0.7,
    annualRainfallMm: 900,
    roofAreaM2: 480,
    ...overrides,
  };
}

function features(overrides: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    distanceToRoadM: 320,
    distanceToWaterwayM: 850,
    nearbyBuildingCount: 140,
    nearbyCommunityFacilityCount: 2,
    slopeProxy: 0.25,
    nearWasteOrIndustrialSite: false,
    insideProtectedArea: false,
    floodProxy: 0.2,
    groundwaterEvidenceScore: 0.65,
    evidenceConfidence: 0.6,
    ...overrides,
  };
}

function climate(overrides: Partial<ClimateData> = {}): ClimateData {
  const annualRainfallMm = overrides.annualRainfallMm ?? 900;
  return {
    annualRainfallMm,
    monthlyRainfallMmDay: Array.from({ length: 12 }, () => annualRainfallMm / 365),
    solarKwhM2Day: 5.4,
    drySeasonMonths: 3,
    source: "test fixture",
    estimated: false,
    ...overrides,
  };
}

function population(overrides: Partial<PopulationEstimate> = {}): PopulationEstimate {
  return {
    peopleServed: 850,
    rangeLow: 640,
    rangeHigh: 1120,
    serviceRadiusM: 1000,
    method: "building_density_proxy",
    methodLabel: "building-density proxy",
    confidence: 0.55,
    limitations: ["Building footprints are incomplete outside mapped areas."],
    ...overrides,
  };
}

function selectionInput(overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    features: features(),
    climate: climate(),
    population: population(),
    hasNearbyMappedWaterPoint: false,
    pipelineLengthM: 620,
    tapStandCount: 4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test("cost totals are positive, ordered, and rounded to planning precision", () => {
  for (const type of ALL_TYPES) {
    const estimate = estimateCost(type, costInput());

    assert.ok(estimate.totalLow > 0, `${type}: totalLow must be positive`);
    assert.ok(estimate.totalHigh > 0, `${type}: totalHigh must be positive`);
    assert.ok(
      estimate.totalLow < estimate.totalHigh,
      `${type}: totalLow ${estimate.totalLow} must be below totalHigh ${estimate.totalHigh}`,
    );
    assert.equal(estimate.totalLow % 1000, 0, `${type}: totalLow must be a multiple of 1000`);
    assert.equal(estimate.totalHigh % 1000, 0, `${type}: totalHigh must be a multiple of 1000`);
    assert.ok(estimate.lineItems.length > 0, `${type}: must produce line items`);
  }
});

test("line items sum to the reported subtotal and each carries a formula and source", () => {
  for (const type of ALL_TYPES) {
    const estimate = estimateCost(type, costInput());
    const low = estimate.lineItems.reduce((sum, item) => sum + item.low, 0);
    const high = estimate.lineItems.reduce((sum, item) => sum + item.high, 0);

    assert.equal(low, estimate.subtotalLow, `${type}: line items must sum to subtotalLow`);
    assert.equal(high, estimate.subtotalHigh, `${type}: line items must sum to subtotalHigh`);

    for (const item of estimate.lineItems) {
      assert.ok(item.formula.length > 0, `${type}/${item.label}: formula must be rendered`);
      assert.ok(item.source.length > 0, `${type}/${item.label}: source must be attributed`);
      assert.ok(item.low <= item.high, `${type}/${item.label}: low must not exceed high`);
    }
  }
});

test("line items differ by infrastructure type", () => {
  const labelsFor = (type: InfrastructureType): string[] =>
    estimateCost(type, costInput()).lineItems.map((item) => item.label);

  const borehole = labelsFor("solar_borehole");
  const rehabilitation = labelsFor("borehole_rehabilitation");
  const rainwater = labelsFor("rainwater_harvesting");

  assert.ok(borehole.some((label) => label.includes("drilling")));
  assert.ok(!rehabilitation.some((label) => label.includes("drilling")));
  assert.ok(rehabilitation.some((label) => label.includes("rehabilitation")));
  assert.ok(!rainwater.some((label) => label.includes("drilling")));
  assert.ok(rainwater.some((label) => label.includes("catchment")));
});

test("stronger groundwater evidence means shallower drilling and lower borehole cost", () => {
  const confidences = [0.1, 0.3, 0.5, 0.7, 0.95];
  const totals = confidences.map(
    (groundwaterConfidence) =>
      estimateCost("solar_borehole", costInput({ groundwaterConfidence })).totalHigh,
  );

  for (let i = 1; i < totals.length; i += 1) {
    assert.ok(
      totals[i] <= totals[i - 1],
      `cost must not rise as groundwater confidence rises (${confidences[i - 1]} -> ${confidences[i]})`,
    );
  }
  assert.ok(
    totals[totals.length - 1] < totals[0],
    "a favourable site must be strictly cheaper to drill than a difficult one",
  );
});

test("access multiplier is 1.0 for a roadside flat site and rises with distance and slope", () => {
  const roadside = computeAccessMultiplier(60, 0);
  assert.equal(roadside.value, 1);
  assert.ok(roadside.reason.includes("flat terrain"));
  assert.ok(roadside.reason.includes("60 m"));

  // The roadside band extends to 100 m.
  assert.equal(computeAccessMultiplier(100, 0).value, 1);

  const remoteSteep = computeAccessMultiplier(1200, 1);
  assert.ok(
    remoteSteep.value > roadside.value,
    "a remote steep site must cost more to reach than a roadside flat one",
  );
  assert.ok(remoteSteep.reason.includes("steep terrain"));

  const example = computeAccessMultiplier(640, 0.5);
  assert.ok(example.reason.startsWith("Site is 640 m from the nearest mapped road on moderate terrain"));

  for (let distance = 0; distance <= 4000; distance += 50) {
    for (let slope = 0; slope <= 1.0001; slope += 0.1) {
      const { value } = computeAccessMultiplier(distance, slope);
      assert.ok(value >= 1, `multiplier must never fall below 1 (${distance} m, slope ${slope})`);
      assert.ok(value <= 1.4, `multiplier must never exceed 1.4 (${distance} m, slope ${slope})`);
    }
  }
});

test("access multiplier is applied to the subtotal to produce the total", () => {
  const input = costInput({ distanceToRoadM: 900, slopeProxy: 0.8 });
  const estimate = estimateCost("solar_borehole", input);
  const expected = computeAccessMultiplier(input.distanceToRoadM, input.slopeProxy);

  assert.equal(estimate.accessMultiplier, expected.value);
  assert.equal(estimate.accessMultiplierReason, expected.reason);
  assert.equal(
    estimate.totalLow,
    Math.floor((estimate.subtotalLow * expected.value) / 1000) * 1000,
  );
  assert.equal(
    estimate.totalHigh,
    Math.ceil((estimate.subtotalHigh * expected.value) / 1000) * 1000,
  );
});

// ---------------------------------------------------------------------------
// Water output
// ---------------------------------------------------------------------------

test("pumped output scales linearly with available solar hours", () => {
  const single = estimateOutput("solar_borehole", outputInput({ solarKwhM2Day: 5 }));
  const double = estimateOutput("solar_borehole", outputInput({ solarKwhM2Day: 10 }));

  assert.equal(double.effectivePumpingHours, single.effectivePumpingHours * 2);
  // Reported volumes are rounded to the nearest 10 L, hence the tolerance.
  assert.ok(Math.abs(double.dailyLitersLow - single.dailyLitersLow * 2) <= 20);
  assert.ok(Math.abs(double.dailyLitersHigh - single.dailyLitersHigh * 2) <= 20);

  const none = estimateOutput("solar_borehole", outputInput({ solarKwhM2Day: 0 }));
  assert.equal(none.dailyLitersHigh, 0);
});

test("rainwater output scales with rainfall and with roof area", () => {
  const dry = estimateOutput("rainwater_harvesting", outputInput({ annualRainfallMm: 600 }));
  const wet = estimateOutput("rainwater_harvesting", outputInput({ annualRainfallMm: 1200 }));
  assert.ok(Math.abs(wet.dailyLitersHigh - dry.dailyLitersHigh * 2) <= 20);

  const small = estimateOutput("rainwater_harvesting", outputInput({ roofAreaM2: 200 }));
  const large = estimateOutput("rainwater_harvesting", outputInput({ roofAreaM2: 400 }));
  assert.ok(Math.abs(large.dailyLitersHigh - small.dailyLitersHigh * 2) <= 20);

  // 480 m2 x 0.9 m x 0.8 runoff = 345.6 m3/yr -> 946 L/day gross.
  const expected = (480 * (900 / 1000) * 0.8 * 1000) / 365;
  assert.ok(Math.abs(estimateOutput("rainwater_harvesting", outputInput()).dailyLitersHigh - expected) <= 10);
});

test("stronger groundwater evidence raises the upper bound of pumped yield", () => {
  const weak = estimateOutput("solar_borehole", outputInput({ groundwaterConfidence: 0.2 }));
  const strong = estimateOutput("solar_borehole", outputInput({ groundwaterConfidence: 0.9 }));

  assert.ok(strong.dailyLitersHigh > weak.dailyLitersHigh);
  assert.equal(strong.dailyLitersLow, weak.dailyLitersLow);
});

test("people supported is consistent with daily litres at 20 L/person/day", () => {
  for (const type of ALL_TYPES) {
    const estimate = estimateOutput(type, outputInput());

    assert.equal(estimate.litersPerPersonPerDay, LITERS_PER_PERSON_PER_DAY);
    assert.equal(
      estimate.peopleSupportedLow,
      Math.floor(estimate.dailyLitersLow / LITERS_PER_PERSON_PER_DAY),
      `${type}: peopleSupportedLow must be floor(dailyLitersLow / 20)`,
    );
    assert.equal(
      estimate.peopleSupportedHigh,
      Math.floor(estimate.dailyLitersHigh / LITERS_PER_PERSON_PER_DAY),
      `${type}: peopleSupportedHigh must be floor(dailyLitersHigh / 20)`,
    );
    assert.ok(estimate.dailyLitersLow <= estimate.dailyLitersHigh, `${type}: yield range ordered`);
    assert.ok(estimate.formula.includes("L/day"), `${type}: formula must render the result`);
  }
});

test("every output estimate warns that borehole yield needs a pumping test", () => {
  for (const type of ALL_TYPES) {
    const { caveats } = estimateOutput(type, outputInput());
    assert.ok(
      caveats.some((caveat) => caveat.includes("pumping test")),
      `${type}: caveats must state that yield is not guaranteed without a pumping test`,
    );
  }
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("selection returns each infrastructure type for the appropriate site", () => {
  const cases: { expected: InfrastructureType; input: SelectionInput }[] = [
    {
      expected: "borehole_rehabilitation",
      input: selectionInput({
        hasNearbyMappedWaterPoint: true,
        features: features({ groundwaterEvidenceScore: 0.5, distanceToMappedWaterPointM: 420 }),
      }),
    },
    {
      expected: "solar_borehole",
      input: selectionInput({
        features: features({ groundwaterEvidenceScore: 0.72 }),
        climate: climate({ solarKwhM2Day: 5.6 }),
      }),
    },
    {
      expected: "rainwater_harvesting",
      input: selectionInput({
        features: features({ groundwaterEvidenceScore: 0.2 }),
        climate: climate({ annualRainfallMm: 1200 }),
      }),
    },
    {
      expected: "community_storage_and_taps",
      input: selectionInput({
        features: features({ groundwaterEvidenceScore: 0.2 }),
        climate: climate({ annualRainfallMm: 400 }),
      }),
    },
    {
      expected: "filtration_and_storage",
      input: selectionInput({
        features: features({ groundwaterEvidenceScore: 0.45 }),
        climate: climate({ annualRainfallMm: 900 }),
      }),
    },
  ];

  const seen = new Set<InfrastructureType>();
  for (const { expected, input } of cases) {
    const { type, rationale } = selectInfrastructureType(input);
    assert.equal(type, expected);
    assert.ok(rationale.length > 0, `${expected}: must explain itself`);
    seen.add(type);
  }
  assert.equal(seen.size, ALL_TYPES.length, "all five templates must be reachable");
});

test("a strong-groundwater site with a weak solar resource falls back to filtration", () => {
  const { type } = selectInfrastructureType(
    selectionInput({
      features: features({ groundwaterEvidenceScore: 0.8 }),
      climate: climate({ solarKwhM2Day: 3.2 }),
    }),
  );
  assert.equal(type, "filtration_and_storage");
});

test("rationale cites the input values that triggered the rule", () => {
  const { rationale } = selectInfrastructureType(
    selectionInput({
      features: features({ groundwaterEvidenceScore: 0.2 }),
      climate: climate({ annualRainfallMm: 1200 }),
    }),
  );
  assert.ok(rationale.some((line) => line.includes("0.20")));
  assert.ok(rationale.some((line) => line.includes("1,200 mm")));
});

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

test("recommendation is well formed and confidence never exceeds the desk-study ceiling", () => {
  const inputs: SelectionInput[] = [
    selectionInput(),
    selectionInput({
      hasNearbyMappedWaterPoint: true,
      features: features({ groundwaterEvidenceScore: 0.5, evidenceConfidence: 1 }),
    }),
    selectionInput({
      features: features({ groundwaterEvidenceScore: 0.1, evidenceConfidence: 1 }),
      climate: climate({ annualRainfallMm: 1400 }),
    }),
    selectionInput({
      features: features({ groundwaterEvidenceScore: 0.1, evidenceConfidence: 1 }),
      climate: climate({ annualRainfallMm: 300 }),
    }),
    selectionInput({ features: features({ groundwaterEvidenceScore: 0.45, evidenceConfidence: 1 }) }),
  ];

  for (const input of inputs) {
    const recommendation = buildRecommendation(input);

    assert.ok(recommendation.confidence > 0);
    assert.ok(
      recommendation.confidence <= 0.85,
      "a desk study must never claim more than 0.85 confidence",
    );
    assert.ok(recommendation.components.length > 0);
    assert.ok(recommendation.assumptions.length > 0);
    assert.ok(recommendation.cost.totalLow < recommendation.cost.totalHigh);
    assert.ok(
      recommendation.implementationRangeWeeks[0] < recommendation.implementationRangeWeeks[1],
    );

    const validation = recommendation.requiredValidation.join(" | ").toLowerCase();
    for (const requirement of [
      "geophysical",
      "water-quality testing",
      "land ownership",
      "community consultation",
      "seasonal access",
      "environmental",
      "engineering design",
    ]) {
      assert.ok(
        validation.includes(requirement),
        `${recommendation.type}: required validation must cover "${requirement}"`,
      );
    }
  }
});

test("drilling validation is required only where drilling applies", () => {
  const drilled = buildRecommendation(
    selectionInput({ features: features({ groundwaterEvidenceScore: 0.72 }) }),
  );
  assert.equal(drilled.type, "solar_borehole");
  assert.ok(drilled.requiredValidation.some((item) => item.includes("Exploratory drilling")));

  const rainwater = buildRecommendation(
    selectionInput({
      features: features({ groundwaterEvidenceScore: 0.1 }),
      climate: climate({ annualRainfallMm: 1400 }),
    }),
  );
  assert.equal(rainwater.type, "rainwater_harvesting");
  assert.ok(!rainwater.requiredValidation.some((item) => item.includes("Exploratory drilling")));
});

test("the depth band shown in the components matches the one the cost model prices", () => {
  for (const groundwaterEvidenceScore of [0.55, 0.6, 0.72, 0.9]) {
    const recommendation = buildRecommendation(
      selectionInput({ features: features({ groundwaterEvidenceScore }) }),
    );
    if (recommendation.type !== "solar_borehole") continue;

    const drilling = recommendation.cost.lineItems.find((item) =>
      item.label.includes("drilling"),
    );
    assert.ok(drilling, "a solar borehole must price drilling");

    const band = /^(\d+)-(\d+) m/.exec(drilling.formula);
    assert.ok(band, `drilling formula must lead with a depth band: ${drilling.formula}`);

    const borehole = recommendation.components.find((c) => c.name === "Borehole");
    assert.ok(borehole, "a solar borehole must list a borehole component");
    assert.ok(
      borehole.detail.includes(`${band[1]}-${band[2]} m`),
      `component detail must quote the priced band (${band[0]}): ${borehole.detail}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("models are deterministic: identical inputs produce deep-equal results", () => {
  for (const type of ALL_TYPES) {
    assert.deepStrictEqual(
      estimateCost(type, costInput()),
      estimateCost(type, costInput()),
      `${type}: estimateCost must be deterministic`,
    );
    assert.deepStrictEqual(
      estimateOutput(type, outputInput()),
      estimateOutput(type, outputInput()),
      `${type}: estimateOutput must be deterministic`,
    );
  }

  assert.deepStrictEqual(buildRecommendation(selectionInput()), buildRecommendation(selectionInput()));
  assert.deepStrictEqual(
    computeAccessMultiplier(640, 0.5),
    computeAccessMultiplier(640, 0.5),
  );
});
