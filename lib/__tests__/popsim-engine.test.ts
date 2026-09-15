/**
 * Unit tests for the household simulation engine (lib/popsim).
 *
 * Fixtures are small hand-made SimulationModels: a few household clusters,
 * one to a few taps and up to three existing sources. Walking minutes are
 * one-way; -1 marks "not reachable".
 *
 * Run with:
 *   node --import tsx --test lib/__tests__/popsim-engine.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { SimulationModel, SimulationRates } from "@/lib/types";
import { BEHAVIOUR, WATER } from "@/lib/config/coefficients";
import {
  assignWeek,
  defaultRates,
  evaluateStatic,
  Future,
  K,
  newWeekResult,
  perTapDailyLitres,
  queueMinutes,
  ratesFromShares,
  runFuture,
  WEEKS_PER_YEAR,
  World,
  type SourceState,
  type WeekResult,
} from "@/lib/popsim/engine";
import { createRng } from "@/lib/popsim/rng";
import { quantile, summarise } from "@/lib/popsim/stats";

const LPD = WATER.litersPerPersonPerDay.value;
const TRIPS = LPD / BEHAVIOUR.containerLitres.value;
const FILL_MIN = BEHAVIOUR.containerLitres.value / BEHAVIOUR.tapFlowLitresPerMinute.value;
const MAX_WAIT = BEHAVIOUR.maxWaitMinutes.value;
const NO_SOURCE = BEHAVIOUR.noSourceRoundTripMinutes.value;
const BASIC = BEHAVIOUR.basicServiceRoundTripMinutes.value;
const UNLIMITED = 1e12;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A household cluster: people, up to K existing sources as [index, one-way minutes], one-way minutes to each tap. */
type Cluster = { people: number; existing?: [number, number][]; taps?: number[] };

/** Nothing ever breaks and nobody moves in. */
const NO_FAILURES: SimulationRates = ratesFromShares(0, 0, 2, 8, 0);

function model(clusters: Cluster[], overrides: Partial<SimulationModel> = {}): SimulationModel {
  const tapCount = overrides.tapCount ?? Math.max(0, ...clusters.map((c) => c.taps?.length ?? 0));
  const baseIdx: number[] = [];
  const baseMin: number[] = [];
  const tapMin: number[] = [];
  for (const c of clusters) {
    for (let k = 0; k < K; k++) {
      const slot = c.existing?.[k];
      baseIdx.push(slot ? slot[0] : -1);
      baseMin.push(slot ? slot[1] : -1);
    }
    for (let t = 0; t < tapCount; t++) tapMin.push(c.taps?.[t] ?? -1);
  }
  return {
    n: clusters.length,
    lon: clusters.map((_, i) => 34.76 + i * 0.001),
    lat: clusters.map(() => -0.1),
    people: clusters.map((c) => c.people),
    baseIdx,
    baseMin,
    existingCount: 3,
    replaces: -1,
    tapCount,
    tapLon: Array.from({ length: tapCount }, () => 34.76),
    tapLat: Array.from({ length: tapCount }, () => -0.1),
    tapMin,
    perTapL: perTapDailyLitres(),
    yieldLowL: UNLIMITED,
    yieldHighL: UNLIMITED,
    rain: null,
    rates: NO_FAILURES,
    weeks: WEEKS_PER_YEAR,
    ...overrides,
  };
}

/**
 * Six clusters and two taps where queues matter but no choice sits on a
 * queue threshold: cluster 2's own source (8 min) beats both taps, everyone
 * else prefers a tap.
 */
function queueModel(overrides: Partial<SimulationModel> = {}): SimulationModel {
  return model(
    [
      { people: 60, existing: [[0, 30]], taps: [2, 9] },
      { people: 50, existing: [[1, 12]], taps: [3, 8] },
      { people: 45, existing: [[2, 4]], taps: [5, 6] },
      { people: 70, taps: [9, 2] },
      { people: 40, existing: [[0, 20]], taps: [7, 4] },
      { people: 35, existing: [[1, 7]], taps: [6, 3] },
    ],
    overrides,
  );
}

function sourceState(w: World, systemCapL: number, overrides: Partial<SourceState> = {}): SourceState {
  return {
    systemUp: true,
    existingUp: new Uint8Array(Math.max(1, w.existingCount)).fill(1),
    systemCapL,
    queue: new Float64Array(Math.max(1, w.T)),
    ...overrides,
  };
}

/** One week on a fresh world with no growth room. */
function runWeek(m: SimulationModel, systemCapL: number, overrides: Partial<SourceState> = {}): { w: World; r: WeekResult } {
  const w = new World(m, 1);
  return { w, r: assignWeek(w, sourceState(w, systemCapL, overrides)) };
}

function near(actual: number, expected: number, tolerance: number, message = "value"): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

const sum = (values: ArrayLike<number>): number => Array.from(values).reduce((a, b) => a + b, 0);
const mean = (values: number[]): number => sum(values) / values.length;
const totalPeople = (w: World): number => sum(w.people.subarray(0, w.n));

/** What one frame said. Frames share one mutable WeekResult, so copy the numbers out as they arrive. */
type FrameSummary = {
  week: number;
  year: number;
  month: number;
  systemUp: boolean;
  capacityL: number;
  storageL: number | null;
  existingDown: number;
  served: number;
  systemLoadL: number;
  saturated: boolean;
};

function runFrames(f: Future): FrameSummary[] {
  const frames: FrameSummary[] = [];
  while (!f.done) {
    const fr = f.step();
    frames.push({
      week: fr.week,
      year: fr.year,
      month: fr.month,
      systemUp: fr.systemUp,
      capacityL: fr.capacityL,
      storageL: fr.storageL,
      existingDown: fr.existingDown,
      served: fr.result.served,
      systemLoadL: fr.result.systemLoadL,
      saturated: fr.result.saturated,
    });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// rng
// ---------------------------------------------------------------------------

test("rng: the same seed replays the same sequence and different seeds diverge", () => {
  const draw = (seed: number) => {
    const r = createRng(seed);
    return Array.from({ length: 1000 }, () => r.next());
  };
  const a = draw(42);
  assert.deepEqual(draw(42), a);

  const b = draw(43);
  assert.notDeepEqual(b, a);
  assert.ok(a.filter((v, i) => v === b[i]).length < 5, "neighbouring seeds must not share a stream");

  const zero = draw(0);
  assert.ok(new Set(zero).size > 990, "seed 0 must not be degenerate");
  for (const v of [...a, ...b, ...zero]) assert.ok(v >= 0 && v < 1, `next() must be in [0, 1), got ${v}`);
  near(mean(a), 0.5, 0.05, "mean of next()");
});

test("rng: int is inclusive at both ends and never leaves its range", () => {
  const r = createRng(7);
  const N = 20_000;
  const counts = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    const v = r.int(2, 5);
    assert.ok(Number.isInteger(v) && v >= 2 && v <= 5, `int(2, 5) gave ${v}`);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  assert.deepEqual([...counts.keys()].sort((x, y) => x - y), [2, 3, 4, 5]);
  for (const [v, c] of counts) near(c / N, 0.25, 0.02, `share of draws equal to ${v}`);

  for (let i = 0; i < 100; i++) assert.equal(r.int(3, 3), 3);
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) seen.add(r.int(-2, 2));
  assert.deepEqual([...seen].sort((x, y) => x - y), [-2, -1, 0, 1, 2]);
});

test("rng: range stays in [low, high) and covers it evenly", () => {
  const r = createRng(11);
  const N = 20_000;
  const values: number[] = [];
  for (let i = 0; i < N; i++) {
    const v = r.range(60, 200);
    assert.ok(v >= 60 && v < 200, `range(60, 200) gave ${v}`);
    values.push(v);
  }
  assert.ok(Math.min(...values) < 61 && Math.max(...values) > 199, "range must reach both ends");
  near(mean(values), 130, 2, "mean of range(60, 200)");
  assert.equal(r.range(5, 5), 5);
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

test("stats: quantile interpolates on a sorted copy and summarise rounds to one decimal", () => {
  assert.equal(quantile([], 0.5), 0);
  const values = [30, 10, 20, 40];
  assert.equal(quantile(values, 0), 10);
  assert.equal(quantile(values, 0.5), 25);
  assert.equal(quantile(values, 1), 40);
  near(quantile(values, 0.1), 13, 1e-12, "p10 of 10..40");
  assert.equal(quantile(values, -1), 10, "p below 0 clamps");
  assert.equal(quantile(values, 2), 40, "p above 1 clamps");
  assert.deepEqual(values, [30, 10, 20, 40], "the input must not be reordered");

  assert.deepEqual(summarise([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { p10: 1.9, p50: 5.5, p90: 9.1 });
  assert.deepEqual(summarise([7]), { p10: 7, p50: 7, p90: 7 });
});

// ---------------------------------------------------------------------------
// queueMinutes
// ---------------------------------------------------------------------------

test("queueMinutes: zero at no load, rising with load, and never above the maximum wait", () => {
  const cap = perTapDailyLitres();
  assert.equal(queueMinutes(0, cap), 0);
  assert.equal(queueMinutes(-100, cap), 0, "negative load is no load");

  let previous = 0;
  for (let step = 1; step <= 19; step++) {
    const q = queueMinutes((step / 20) * cap, cap);
    assert.ok(q > previous, `the wait must rise with load (load share ${step / 20})`);
    previous = q;
  }
  // A single server with a fixed fill time: at half load the mean wait is half a fill.
  near(queueMinutes(0.5 * cap, cap), FILL_MIN / 2, 1e-9, "wait at 50% load");

  for (const load of [0.99 * cap, cap, 2 * cap, 1e9, Infinity]) {
    const q = queueMinutes(load, cap);
    assert.ok(Number.isFinite(q) && q <= MAX_WAIT, `wait ${q} at load ${load} must be finite and at most ${MAX_WAIT}`);
    assert.ok(q >= previous, `overload must not shorten the queue (load ${load})`);
  }
  const dead = queueMinutes(100, 0);
  assert.ok(dead > 0 && dead <= MAX_WAIT, "a tap that dispenses nothing has a long but capped wait");
});

// ---------------------------------------------------------------------------
// ratesFromShares
// ---------------------------------------------------------------------------

test("ratesFromShares: the weekly failure probability implies the requested down share", () => {
  for (const [low, high] of [[2, 8], [1, 1], [3, 9], [4, 4]]) {
    const r = (low + high) / 2;
    for (const s of [0.02, 0.1, 0.25, 0.4, 0.5]) {
      const rates = ratesFromShares(s, s / 2, low, high, 0.03);
      for (const [p, share] of [[rates.failExisting, s], [rates.failProject, s / 2]]) {
        assert.ok(p > 0 && p <= 1, `probability ${p} for share ${share}`);
        near((p * r) / (1 + p * r), share, 1e-12, `p*r/(1+p*r) for share ${share}, repairs ${low}-${high} weeks`);
      }
      assert.equal(rates.shareExisting, s);
      assert.deepEqual([rates.repairLow, rates.repairHigh, rates.growth], [low, high, 0.03]);
    }
  }

  const zero = ratesFromShares(0, 0, 2, 8, 0.035);
  assert.equal(zero.failExisting, 0);
  assert.equal(zero.failProject, 0);
  assert.equal(ratesFromShares(0.9, 0.99, 1, 1, 0).failProject, 1, "an unreachable share saturates at certainty");

  assert.deepEqual(
    defaultRates(),
    ratesFromShares(
      BEHAVIOUR.nonFunctionalShare.existing,
      BEHAVIOUR.nonFunctionalShare.project,
      BEHAVIOUR.repairWeeks.low,
      BEHAVIOUR.repairWeeks.high,
      BEHAVIOUR.annualGrowthRate.value,
    ),
  );
});

test("ratesFromShares + Future: over a long horizon sources are down for the requested share of weeks", () => {
  const rates = ratesFromShares(0.25, 0.1, 2, 8, 0);
  // A model whose only purpose is failures: one cluster, one tap, three existing sources.
  const m = model([{ people: 10, existing: [[0, 5], [1, 6], [2, 7]], taps: [1] }], {
    rates,
    weeks: 400 * WEEKS_PER_YEAR,
  });
  for (const seed of [1, 2, 3]) {
    const f = new Future(m, seed);
    let existingDownWeeks = 0;
    while (!f.done) existingDownWeeks += f.step().existingDown;
    near(f.outcome().weeksDown / m.weeks, 0.1, 0.02, `project down share, seed ${seed}`);
    near(existingDownWeeks / (m.existingCount * m.weeks), 0.25, 0.02, `existing down share, seed ${seed}`);
  }
});

// ---------------------------------------------------------------------------
// perTapDailyLitres
// ---------------------------------------------------------------------------

test("perTapDailyLitres: a tap's hard limit is its flow over the dispensing day, above its design load", () => {
  const limit = perTapDailyLitres();
  near(limit, BEHAVIOUR.tapFlowLitresPerMinute.value * 60 * BEHAVIOUR.tapWindowHours.value, 1e-9, "daily limit");
  // The design load must leave headroom, or every fully loaded tap sits at utilisation 1.
  const designLoad = BEHAVIOUR.peoplePerTap.value * LPD;
  assert.ok(designLoad < limit, `design load ${designLoad} L must be below the physical limit ${limit} L`);
  const wait = queueMinutes(designLoad, limit);
  assert.ok(wait > 0 && wait < queueMinutes(limit, limit), `a tap at its design load queues ${wait} min, less than at its limit`);
});

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

test("World.reorder: the cluster nearest a tap comes first and unreachable clusters come last", () => {
  const m = model([
    { people: 10, taps: [9, -1] },
    { people: 10, taps: [-1, -1] },
    { people: 10, taps: [4, 6] },
    { people: 10, taps: [-1, 2] },
    { people: 10, taps: [-1, -1] },
    { people: 10, taps: [4, 7] },
  ]);
  // Keys: nearest reachable tap 9, none, 4, 2, none, 4. Ties keep index order.
  assert.deepEqual(Array.from(new World(m, 1).order), [3, 2, 5, 0, 1, 4]);
});

test("World.addCluster: a child inherits the parent's walks plus the extra distance, within capacity", () => {
  const m = model([
    { people: 30, existing: [[2, 10], [0, 14]], taps: [5, -1] },
    { people: 20, existing: [[1, 3]], taps: [-1, 8] },
  ]);
  const w = new World(m, 2);
  assert.equal(w.cap, 4);

  assert.equal(w.addCluster(0, 34.8, -0.2, 7, 1.5), true);
  assert.equal(w.n, 3);
  assert.deepEqual([w.lon[2], w.lat[2], w.people[2]], [34.8, -0.2, 7]);
  assert.deepEqual(Array.from(w.baseIdx.subarray(2 * K, 3 * K)), [2, 0, -1]);
  assert.deepEqual(Array.from(w.baseMin.subarray(2 * K, 3 * K)), [11.5, 15.5, -1], "-1 stays -1");
  assert.deepEqual(Array.from(w.tapMin.subarray(2 * w.T, 3 * w.T)), [6.5, -1], "-1 stays -1");
  assert.deepEqual(Array.from(w.baseMin.subarray(0, K)), [10, 14, -1], "the parent's row is untouched");

  // Reordered, the child (tap 0 at 6.5) sits between its parent (5) and cluster 1 (8).
  w.reorder();
  assert.deepEqual(Array.from(w.order), [0, 2, 1]);

  assert.equal(w.addCluster(1, 0, 0, 5, 0), true);
  assert.equal(w.addCluster(1, 0, 0, 5, 0), false, "a full world refuses new clusters");
  assert.equal(w.n, 4, "a refused cluster must not change n");
  assert.equal(new World(m, 1).addCluster(0, 0, 0, 1, 1), false, "headroom 1 leaves no room");

  // The world is a copy: growing it never touches the model.
  w.people[0] = 999;
  assert.equal(m.people[0], 30);
  assert.equal(m.n, 2);
});

// ---------------------------------------------------------------------------
// assignWeek
// ---------------------------------------------------------------------------

test("assignWeek: a tap closer than every existing source attracts its clusters", () => {
  const m = model([
    { people: 40, existing: [[0, 10], [1, 12]], taps: [3] },
    { people: 25, taps: [6] }, // nothing mapped nearby
  ]);
  const { r } = runWeek(m, UNLIMITED);
  assert.deepEqual(Array.from(r.servedFrac), [1, 1]);
  assert.deepEqual(Array.from(r.minutes), [6, 12]);
  assert.deepEqual(Array.from(r.baseline), [20, NO_SOURCE]);
  near(r.served, 65, 1e-9, "served");
  near(r.systemLoadL, 65 * LPD, 1e-9, "system load");
  near(r.hoursSaved, (40 * TRIPS * (20 - 6) + 25 * TRIPS * (NO_SOURCE - 12)) / 60, 1e-9, "hours saved");
});

test("assignWeek: scarce capacity goes to the clusters nearest a tap and the boundary cluster splits", () => {
  // Four clusters of 10 people, listed out of distance order, and room for two and a half of them.
  const m = model([
    { people: 10, taps: [6] }, // third nearest
    { people: 10, taps: [2] }, // nearest
    { people: 10, taps: [4] }, // second
    { people: 10, taps: [8] }, // farthest
  ]);
  const { r } = runWeek(m, 2.5 * 10 * LPD);
  assert.equal(r.servedFrac[1], 1);
  assert.equal(r.servedFrac[2], 1);
  assert.ok(r.servedFrac[0] > 0 && r.servedFrac[0] < 1, `the boundary cluster must split, got ${r.servedFrac[0]}`);
  near(r.servedFrac[0], 0.5, 1e-12, "boundary share");
  assert.equal(r.servedFrac[3], 0);
  // The unserved half walks the fallback.
  near(r.minutes[0], 0.5 * 12 + 0.5 * NO_SOURCE, 1e-9, "boundary cluster minutes");
  assert.equal(r.minutes[3], NO_SOURCE);
  near(r.served, 25, 1e-9, "served");
});

test("assignWeek: the per-tap limit binds on its own and overflow spills to the next tap", () => {
  const one = model([{ people: 10, taps: [2] }, { people: 10, taps: [3] }, { people: 10, taps: [4] }], { perTapL: 300 });
  const tapBound = runWeek(one, UNLIMITED).r;
  near(tapBound.tapLoadL[0], 300, 1e-9, "tap load");
  near(tapBound.served, 15, 1e-9, "served under the tap limit");
  assert.equal(tapBound.servedFrac[0], 1);
  near(tapBound.servedFrac[1], 0.5, 1e-12, "boundary share");
  assert.equal(tapBound.servedFrac[2], 0);

  // Same world, a system cap below the tap limit: now the system binds.
  near(runWeek(one, 250).r.served, 12.5, 1e-9, "served under the system cap");

  // Two taps of 300 L: a 400 L cluster fills its nearer tap and takes the rest from the other.
  const two = runWeek(model([{ people: 20, taps: [2, 5] }], { perTapL: 300 }), UNLIMITED).r;
  near(two.tapLoadL[0], 300, 1e-9, "nearer tap");
  near(two.tapLoadL[1], 100, 1e-9, "farther tap");
  near(two.servedFrac[0], 1, 1e-12, "fully served across two taps");
  near(two.minutes[0], 0.75 * 4 + 0.25 * 10, 1e-9, "demand-weighted round trip");
});

test("assignWeek: overflow reaches every tap, even in systems with more than 32 taps", () => {
  // 34 taps; the cluster reaches only tap 0 (1 min) and tap 32 (2 min), each good for 100 L/day.
  const taps = Array.from({ length: 34 }, () => -1);
  taps[0] = 1;
  taps[32] = 2;
  const { r } = runWeek(model([{ people: 10, taps }], { perTapL: 100 }), UNLIMITED);
  near(r.tapLoadL[0], 100, 1e-9, "tap 0");
  near(r.tapLoadL[32], 100, 1e-9, "tap 32");
  near(r.servedFrac[0], 1, 1e-12, "served fraction");
});

test("assignWeek: with the system down nobody is served and everyone walks their baseline", () => {
  const m = model([
    { people: 40, existing: [[0, 10]], taps: [3] },
    { people: 25, taps: [6] },
    { people: 15, existing: [[1, 2]], taps: [1] },
  ]);
  const cases: [string, number, Partial<SourceState>][] = [
    ["system down", UNLIMITED, { systemUp: false }],
    ["no water this week", 0, {}],
  ];
  for (const [label, cap, overrides] of cases) {
    const { w, r } = runWeek(m, cap, { queue: Float64Array.from([4]), ...overrides });
    assert.equal(r.served, 0, label);
    assert.equal(r.systemLoadL, 0, label);
    assert.equal(r.under30, 0, label);
    assert.equal(r.hoursSaved, 0, label);
    assert.equal(r.saturated, false, label);
    assert.deepEqual(Array.from(r.tapLoadL), [0], label);
    assert.deepEqual(Array.from(r.baseline.subarray(0, w.n)), [20, NO_SOURCE, 4], label);
    for (let i = 0; i < w.n; i++) {
      assert.equal(r.servedFrac[i], 0, `${label}: cluster ${i}`);
      assert.equal(r.minutes[i], r.baseline[i], `${label}: cluster ${i} walks its baseline`);
    }
  }
});

test("assignWeek: a cluster whose existing source beats every tap stays with it", () => {
  const m = model([
    { people: 30, existing: [[0, 2]], taps: [5, 7] }, // own source 4 min round trip; taps 10 and 14
    { people: 30, existing: [[1, 5]], taps: [5] }, // a tie is not an improvement
    { people: 30, existing: [[2, 6]], taps: [5] }, // 10 < 12: takes the tap while it has no queue
  ]);
  const free = runWeek(m, UNLIMITED).r;
  assert.deepEqual(Array.from(free.servedFrac), [0, 0, 1]);
  assert.deepEqual(Array.from(free.minutes), [4, 10, 10]);
  near(free.served, 30, 1e-9, "served");

  const queued = runWeek(m, UNLIMITED, { queue: Float64Array.from([3, 0]) }).r;
  assert.equal(queued.servedFrac[2], 0, "a queue that makes the tap slower sends the cluster back");
  assert.equal(queued.minutes[2], 12);
  assert.equal(queued.served, 0);
});

test("assignWeek: under30 counts only project-served people within the basic-service round trip", () => {
  assert.ok(BASIC + 10 < NO_SOURCE, "fixture assumes the basic-service trip is well under the no-source trip");
  const half = BASIC / 2;
  const m = model([
    { people: 10, taps: [half - 5] }, // round trip BASIC - 10
    { people: 20, taps: [half] }, // exactly BASIC: counts
    { people: 40, taps: [half + 5] }, // BASIC + 10: served, but not within the limit
    { people: 80, existing: [[0, 5]] }, // a 10-minute walk to its own source is not project service
  ]);
  const all = runWeek(m, UNLIMITED).r;
  near(all.served, 70, 1e-9, "served");
  near(all.under30, 30, 1e-9, "under30");

  // Room for 20 people: cluster 0 in full, then half of cluster 1.
  const partial = runWeek(m, 20 * LPD).r;
  near(partial.servedFrac[1], 0.5, 1e-12, "boundary share");
  near(partial.under30, 20, 1e-9, "under30 counts the served share only");
});

test("assignWeek: the baseline is the nearest working source and never exceeds the no-source trip", () => {
  const m = model(
    [
      { people: 10 }, // nothing mapped
      { people: 10, existing: [[1, NO_SOURCE / 2 + 15]] }, // mapped, but farther than the no-source trip
      { people: 10, existing: [[1, 12], [2, 8]] }, // the nearer of two working sources
      { people: 10, existing: [[0, 4], [1, 9]] }, // the nearest is down: the next one
    ],
    { tapCount: 0 },
  );
  const { w, r } = runWeek(m, UNLIMITED, { existingUp: Uint8Array.from([0, 1, 1]) });
  assert.deepEqual(Array.from(r.baseline.subarray(0, w.n)), [NO_SOURCE, NO_SOURCE, 16, 18]);
  for (let i = 0; i < w.n; i++) {
    assert.ok(r.baseline[i] <= NO_SOURCE, `cluster ${i}`);
    assert.equal(r.minutes[i], r.baseline[i], "with no taps everyone walks their baseline");
  }
  assert.equal(runWeek(m, UNLIMITED).r.baseline[3], 8, "with source 0 working it is the nearest");
});

test("assignWeek: a replaced source is gone in the project world but still sets the no-project baseline", () => {
  // Source 0 is the well the project rehabilitates; its tap stands where the well was.
  const m = model(
    [
      { people: 30, existing: [[0, 5], [1, 20]], taps: [5] }, // used the old well
      { people: 20, existing: [[1, 20]], taps: [3] }, // never did
    ],
    { replaces: 0 },
  );
  const up = runWeek(m, UNLIMITED).r;
  assert.deepEqual(Array.from(up.baseline), [10, 40], "the no-project world still has the old well");
  assert.equal(up.servedFrac[0], 1, "in the project world the tap beats the next source (40 min)");
  assert.equal(up.minutes[0], 10);
  near(up.hoursSaved, (20 * TRIPS * (40 - 6)) / 60, 1e-9, "rehabilitating a working well saves its users nothing");

  // Without `replaces` the old well ties the tap, and a tie keeps the cluster on the well.
  assert.equal(runWeek({ ...m, replaces: -1 }, UNLIMITED).r.servedFrac[0], 0);

  // Project down: cluster 0 has lost its well, and the loss shows against the real baseline.
  const down = runWeek(m, UNLIMITED, { systemUp: false }).r;
  assert.deepEqual(Array.from(down.minutes), [40, 40]);
  near(down.hoursSaved, (30 * TRIPS * (10 - 40)) / 60, 1e-9, "hours lost while the project is down");

  // The baseline follows the old well's own state: broken, it cannot count.
  const broken = runWeek(m, UNLIMITED, { existingUp: Uint8Array.from([0, 1, 1]) }).r;
  assert.equal(broken.baseline[0], 40);
  near(broken.hoursSaved, (30 * TRIPS * (40 - 10) + 20 * TRIPS * (40 - 6)) / 60, 1e-9, "hours saved");
});

test("assignWeek: saturated once load reaches 95% of the binding capacity", () => {
  // System cap 1,000 L/day binds (the tap allows far more).
  const oneTap = (people: number) => model([{ people, taps: [2] }]);
  assert.equal(runWeek(oneTap(47.5), 1000).r.saturated, true, "950 of 1,000 L");
  assert.equal(runWeek(oneTap(47), 1000).r.saturated, false, "940 of 1,000 L");
  assert.equal(runWeek(oneTap(500), 1000).r.saturated, true, "demand far above capacity");
  // Tap limits bind: two taps of 500 L under an unlimited system.
  const twoTaps = (people: number) => model([{ people, taps: [2, 3] }], { perTapL: 500 });
  assert.equal(runWeek(twoTaps(48), UNLIMITED).r.saturated, true, "960 of 1,000 L across two taps");
  assert.equal(runWeek(twoTaps(45), UNLIMITED).r.saturated, false, "900 of 1,000 L across two taps");
  // Down or dry: never saturated.
  assert.equal(runWeek(oneTap(500), 1000, { systemUp: false }).r.saturated, false);
  assert.equal(runWeek(oneTap(500), 0).r.saturated, false);
});

test("assignWeek: conservation and no-harm invariants hold on random worlds", () => {
  const rng = createRng(2024);
  for (let trial = 0; trial < 60; trial++) {
    const T = rng.int(1, 3);
    const clusters: Cluster[] = Array.from({ length: rng.int(1, 12) }, () => ({
      people: rng.range(0, 120),
      existing: Array.from({ length: rng.int(0, 3) }, (): [number, number] => [rng.int(0, 2), rng.range(1, 40)]),
      taps: Array.from({ length: T }, () => (rng.next() < 0.2 ? -1 : rng.range(0.5, 25))),
    }));
    const m = model(clusters, { tapCount: T, perTapL: rng.range(200, 3000) });
    const w = new World(m, 1);
    const s = sourceState(w, rng.range(0, 8000), {
      existingUp: Uint8Array.from([0, 1, 2], () => (rng.next() < 0.7 ? 1 : 0)),
      queue: Float64Array.from({ length: T }, () => rng.range(0, 10)),
    });
    const r = assignWeek(w, s);
    const tag = `trial ${trial}`;

    let served = 0;
    let saved = 0;
    for (let i = 0; i < w.n; i++) {
      assert.ok(r.servedFrac[i] >= 0 && r.servedFrac[i] <= 1 + 1e-12, `${tag}: servedFrac ${r.servedFrac[i]}`);
      assert.ok(r.baseline[i] <= NO_SOURCE, `${tag}: baseline ${r.baseline[i]}`);
      assert.ok(r.minutes[i] <= r.baseline[i] + 1e-9, `${tag}: the project must never lengthen a trip`);
      served += w.people[i] * r.servedFrac[i];
      saved += (w.people[i] * TRIPS * (r.baseline[i] - r.minutes[i])) / 60;
    }
    near(r.served, served, 1e-9, `${tag}: served`);
    near(r.systemLoadL, served * LPD, 1e-6, `${tag}: litres follow people`);
    near(sum(r.tapLoadL), r.systemLoadL, 1e-6, `${tag}: tap loads add up`);
    near(r.hoursSaved, saved, 1e-9, `${tag}: hours saved`);
    assert.ok(r.systemLoadL <= s.systemCapL + 1e-6, `${tag}: the system cap holds`);
    for (let t = 0; t < T; t++) assert.ok(r.tapLoadL[t] <= m.perTapL + 1e-6, `${tag}: tap ${t} limit holds`);
    assert.ok(r.served <= totalPeople(w) + 1e-9, `${tag}: served within population`);
    assert.ok(r.under30 <= r.served + 1e-9, `${tag}: under30 within served`);
  }
});

test("assignWeek: a reused result is reset each week, not accumulated", () => {
  const m = model([{ people: 40, taps: [3] }, { people: 25, existing: [[0, 4]], taps: [6] }]);
  const w = new World(m, 1);
  const s = sourceState(w, UNLIMITED);
  const fresh = assignWeek(w, s);
  const out = newWeekResult(w.cap, w.T);
  assert.equal(assignWeek(w, s, out), out, "the supplied result is filled in place");
  const again = assignWeek(w, s, out);
  assert.equal(again.served, fresh.served);
  assert.equal(again.systemLoadL, fresh.systemLoadL);
  assert.equal(again.hoursSaved, fresh.hoursSaved);
  assert.deepEqual(Array.from(again.tapLoadL), Array.from(fresh.tapLoadL));

  const down = assignWeek(w, { ...s, systemUp: false }, out);
  assert.equal(down.systemLoadL, 0);
  assert.deepEqual(Array.from(down.tapLoadL), [0]);
  assert.equal(down.servedFrac[0], 0);
});

// ---------------------------------------------------------------------------
// evaluateStatic
// ---------------------------------------------------------------------------

test("evaluateStatic: finite queues, deterministic output, and never more served than live there", () => {
  const cases = [queueModel(), queueModel({ yieldLowL: 2000, yieldHighL: 3000 }), model([{ people: 50 }], { tapCount: 0 })];
  for (const m of cases) {
    const snapshot = structuredClone(m);
    const a = evaluateStatic(m);
    const b = evaluateStatic(m);
    assert.deepEqual(m, snapshot, "the model must not be mutated");
    assert.deepEqual(a.result, b.result, "same model, same result");
    assert.deepEqual(Array.from(a.queue), Array.from(b.queue));
    for (const q of a.queue) assert.ok(Number.isFinite(q) && q >= 0 && q <= MAX_WAIT, `queue ${q}`);
    assert.ok(a.result.served <= sum(m.people) + 1e-9, "served within population");
    assert.ok(a.result.under30 <= a.result.served + 1e-9, "under30 within served");
    assert.ok(a.result.systemLoadL <= (m.yieldLowL + m.yieldHighL) / 2 + 1e-6, "the design yield caps the load");
  }
});

test("evaluateStatic: queues follow load, and a capped design serves exactly its yield", () => {
  const open = evaluateStatic(queueModel());
  const [load0, load1] = open.result.tapLoadL;
  assert.notEqual(load0, load1);
  assert.equal(open.queue[0] > open.queue[1], load0 > load1, "the busier tap has the longer queue");
  assert.equal(open.result.servedFrac[2], 0, "cluster 2's own 8-minute round trip beats both taps");
  near(open.result.served, 255, 1e-9, "everyone else is served");

  const capped = evaluateStatic(queueModel({ yieldLowL: 2000, yieldHighL: 3000 }));
  near(capped.result.served, 2500 / LPD, 1e-9, "a 2,500 L/day design serves 125 people");
  assert.equal(capped.result.saturated, true);
});

// ---------------------------------------------------------------------------
// Future
// ---------------------------------------------------------------------------

test("Future: the same seed replays the same future and different seeds differ", () => {
  const m = queueModel({ yieldLowL: 3000, yieldHighL: 6000, rates: defaultRates(), weeks: 3 * WEEKS_PER_YEAR });
  const a = runFrames(new Future(m, 7));
  assert.deepEqual(runFrames(new Future(m, 7)), a);
  assert.deepEqual(runFuture(m, 7), runFuture(m, 7));
  assert.notDeepEqual(runFrames(new Future(m, 8)), a);
  assert.notDeepEqual(runFuture(m, 8), runFuture(m, 7));
});

test("Future: with nothing failing, no growth and a fixed yield, every week serves the static design", () => {
  for (const yieldL of [UNLIMITED, 2500]) {
    const m = queueModel({ yieldLowL: yieldL, yieldHighL: yieldL, rates: NO_FAILURES, weeks: 2 * WEEKS_PER_YEAR });
    const designed = evaluateStatic(m).result.served;
    for (const seed of [1, 2]) {
      const f = new Future(m, seed);
      const frames = runFrames(f);
      assert.equal(frames.length, m.weeks);
      for (const fr of frames) {
        assert.equal(fr.systemUp, true);
        assert.equal(fr.existingDown, 0);
        near(fr.served, designed, 1e-6, `yield ${yieldL}, seed ${seed}, week ${fr.week}`);
      }
      const o = f.outcome();
      assert.equal(o.weeksDown, 0);
      assert.equal(o.clustersAtEnd, m.n);
      near(o.peopleServed, designed, 1e-6, "mean people served");
    }
  }
});

test("Future: growth adds clusters and compounds total people by (1 + g) each year", () => {
  const g = 0.05;
  const m = queueModel({ rates: { ...NO_FAILURES, growth: g }, weeks: 8 * WEEKS_PER_YEAR });
  const p0 = sum(m.people);
  const f = new Future(m, 3);
  let lastN = f.world.n;
  while (!f.done) {
    const fr = f.step();
    if (fr.week % WEEKS_PER_YEAR !== 0) continue;
    near(totalPeople(f.world) / p0, Math.pow(1 + g, fr.year), 1e-9, `people in year ${fr.year}`);
    assert.ok(f.world.n >= lastN, "clusters are never removed");
    if (fr.year > 0 && lastN < f.world.cap) assert.ok(f.world.n > lastN, `year ${fr.year} must add a cluster while there is room`);
    lastN = f.world.n;
  }
  assert.ok(f.world.n > m.n, "growth must add clusters");
  assert.ok(f.world.n <= f.world.cap, "growth respects capacity");
  assert.deepEqual(
    Array.from(f.world.order).sort((a, b) => a - b),
    Array.from({ length: f.world.n }, (_, i) => i),
    "every cluster, old and new, has one place in the order",
  );
  assert.deepEqual(m.people, [60, 50, 45, 70, 40, 35], "the model itself does not grow");
});

function rainModel(rain: NonNullable<SimulationModel["rain"]>, overrides: Partial<SimulationModel> = {}): SimulationModel {
  return model([{ people: 20, taps: [2] }], {
    yieldLowL: 300,
    yieldHighL: 400,
    rain,
    rates: NO_FAILURES,
    weeks: 4 * WEEKS_PER_YEAR,
    ...overrides,
  });
}

test("Future (rain): storage stays within the tank, and dry months supply less than wet ones", () => {
  const rain = { catchmentM2: 100, storageL: 10_000, monthlyMmDay: [8, 8, 8, 8, 8, 8, 0, 0, 0, 0, 0, 0], runoff: 0.8 };
  for (const seed of [1, 2, 3]) {
    const frames = runFrames(new Future(rainModel(rain), seed));
    for (const fr of frames) {
      assert.ok(fr.storageL !== null && fr.storageL >= 0 && fr.storageL <= rain.storageL, `week ${fr.week}: storage ${fr.storageL}`);
      assert.ok(fr.systemLoadL <= fr.capacityL + 1e-9, `week ${fr.week}: the draw must fit the supply`);
    }
    const storage = frames.map((fr) => fr.storageL as number);
    assert.equal(Math.min(...storage), 0, "the tank runs dry in the dry season");
    assert.ok(Math.max(...storage) > 0.9 * rain.storageL, "and fills in the wet season");
    const wet = mean(frames.filter((fr) => fr.month < 6).map((fr) => fr.capacityL));
    const dry = mean(frames.filter((fr) => fr.month >= 6).map((fr) => fr.capacityL));
    assert.ok(dry < wet, `seed ${seed}: dry-month capacity ${dry} must be below wet-month ${wet}`);
  }
});

test("Future (rain): a system with no catchment has no water to serve", () => {
  const rain = { catchmentM2: 0, storageL: 10_000, monthlyMmDay: Array.from({ length: 12 }, () => 5), runoff: 0.8 };
  // A consistent model reports zero yield for zero catchment; the answer must not hinge on the yield figure.
  for (const yieldL of [0, 2000]) {
    const m = rainModel(rain, { yieldLowL: yieldL, yieldHighL: yieldL, weeks: 2 * WEEKS_PER_YEAR });
    for (const fr of runFrames(new Future(m, 1))) {
      assert.equal(fr.capacityL, 0, `yield ${yieldL}, week ${fr.week}: capacity`);
      assert.equal(fr.served, 0, `yield ${yieldL}, week ${fr.week}: served`);
      assert.equal(fr.storageL, 0, `yield ${yieldL}, week ${fr.week}: storage`);
    }
    assert.equal(runFuture(m, 1).peopleServed, 0);
  }
});

test("Future (rain): with no tank the system supplies only what falls that week", () => {
  const mm = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const m = rainModel({ catchmentM2: 100, storageL: 0, monthlyMmDay: mm, runoff: 0.8 }, { people: [1000], weeks: 3 * WEEKS_PER_YEAR });
  const v = BEHAVIOUR.rainfallYearVariation.value;
  for (const fr of runFrames(new Future(m, 2))) {
    assert.equal(fr.storageL, 0);
    // Litres per day off the roof this month, scaled by this year's rainfall.
    const ratio = fr.capacityL / (100 * mm[fr.month] * 0.8);
    assert.ok(ratio >= 1 - v - 1e-9 && ratio <= 1 + v + 1e-9, `week ${fr.week}: supply / rainfall = ${ratio}`);
  }
});

test("Future: capacityYear is year 1 for a system far too small and null for a huge one", () => {
  const clusters: Cluster[] = [{ people: 500, taps: [2] }, { people: 300, taps: [4] }];
  const weeks = 10 * WEEKS_PER_YEAR;
  const small = model(clusters, { yieldLowL: 100, yieldHighL: 150, rates: defaultRates(), weeks });
  const huge = model(clusters, { yieldLowL: 1e7, yieldHighL: 1e7, perTapL: 1e7, rates: defaultRates(), weeks });
  for (const seed of [1, 2, 3]) {
    assert.equal(runFuture(small, seed).capacityYear, 1, `seed ${seed}: small`);
    assert.equal(runFuture(huge, seed).capacityYear, null, `seed ${seed}: huge`);
  }
});

test("Future: frames count weeks, years and months, and a down week serves nobody", () => {
  const m = queueModel({ yieldLowL: 3000, yieldHighL: 6000, rates: ratesFromShares(0.25, 0.3, 2, 8, 0), weeks: 2 * WEEKS_PER_YEAR + 5 });
  const f = new Future(m, 5);
  const frames = runFrames(f);
  assert.equal(frames.length, m.weeks);
  frames.forEach((fr, i) => {
    assert.equal(fr.week, i);
    assert.equal(fr.year, Math.floor(i / WEEKS_PER_YEAR));
    assert.ok(Number.isInteger(fr.month) && fr.month >= 0 && fr.month < 12, `month ${fr.month}`);
    if (i > 0 && fr.year === frames[i - 1].year) assert.ok(fr.month >= frames[i - 1].month, "months run forward");
    assert.equal(fr.storageL, null, "no tank without a rain model");
    assert.ok(fr.existingDown >= 0 && fr.existingDown <= m.existingCount);
    if (!fr.systemUp) {
      assert.equal(fr.capacityL, 0);
      assert.equal(fr.served, 0);
      assert.equal(fr.saturated, false);
    }
  });
  assert.deepEqual([frames[0].month, frames[WEEKS_PER_YEAR - 1].month, frames[WEEKS_PER_YEAR].month], [0, 11, 0]);
  const down = frames.filter((fr) => !fr.systemUp).length;
  assert.ok(down > 0, "a 30% down share must show some downtime");
  const o = f.outcome();
  assert.equal(o.weeksDown, down);
  near(o.peopleServed, mean(frames.map((fr) => fr.served)), 1e-9, "the outcome averages the weekly served");
  assert.equal(o.clustersAtEnd, m.n);
});

test("runFuture: equals stepping a Future to done, and leaves the shared model untouched", () => {
  const m = queueModel({ yieldLowL: 3000, yieldHighL: 6000, rates: { ...defaultRates(), growth: 0.04 }, weeks: 3 * WEEKS_PER_YEAR + 10 });
  const snapshot = structuredClone(m);
  const f = new Future(m, 99);
  let steps = 0;
  while (!f.done) {
    f.step();
    steps++;
  }
  assert.equal(steps, m.weeks);
  assert.deepEqual(runFuture(m, 99), f.outcome());
  assert.deepEqual(m, snapshot, "futures must not mutate the model they share");
});
