/**
 * DEV ONLY. Builds a SimulationResult for the cached Kisumu run with straight-
 * line walking, so the interface can be built before the full pipeline lands.
 * Writes data/fixtures/simulation-dev.json and attaches it to the cached run.
 *   node --import tsx scripts/dev-sim-fixture.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { AnalysisRun, SimulationModel, SimulationProject, SimulationResult } from "@/lib/types";
import { BEHAVIOUR, SERVICE } from "@/lib/config/coefficients";
import { defaultRates, evaluateStatic, K, perTapDailyLitres, runFuture, SPEED_M_PER_MIN } from "@/lib/popsim/engine";
import { summarise } from "@/lib/popsim/stats";

const RUN = "data/runs/kisumu-kenya.json";
const run = JSON.parse(readFileSync(RUN, "utf8")) as AnalysisRun;
const w = run.candidates.find((c) => c.id === run.winnerId)!;
const layout = run.layout!;
const rec = run.recommendation!;
const mLat = 111_320;
const mLon = mLat * Math.cos((w.lat * Math.PI) / 180);
const dist = (a: number, b: number, c: number, d: number) => Math.hypot((c - a) * mLon, (d - b) * mLat);
const oneWay = (m: number) => (m * BEHAVIOUR.detourFactor.value) / SPEED_M_PER_MIN;

// Clusters: sample buildings within 2.2 km, 100 m cells.
const ppb = ((SERVICE.peoplePerBuilding.low + SERVICE.peoplePerBuilding.high) / 2) * run.osm.buildingSampleRatio;
const cells = new Map<string, { lon: number; lat: number; count: number }>();
for (const b of run.osm.buildings) {
  if (dist(w.lon, w.lat, b.lon, b.lat) > 2200) continue;
  const k = `${Math.floor(b.lon * mLon / 100)},${Math.floor(b.lat * mLat / 100)}`;
  const c = cells.get(k) ?? { lon: 0, lat: 0, count: 0 };
  c.lon += b.lon; c.lat += b.lat; c.count++;
  cells.set(k, c);
}
const clusters = [...cells.values()].map((c) => ({ lon: c.lon / c.count, lat: c.lat / c.count, people: c.count * ppb }));
const improved = run.osm.waterPoints.filter((p) => ["water_well", "borehole", "drinking_water", "spring"].includes(p.kind));

const n = clusters.length;
const baseIdx: number[] = [];
const baseMin: number[] = [];
for (const c of clusters) {
  const ranked = improved.map((p, j) => ({ j, d: dist(c.lon, c.lat, p.lon, p.lat) })).sort((a, b) => a.d - b.d).slice(0, K);
  for (let k = 0; k < K; k++) {
    const r = ranked[k];
    baseIdx.push(r && r.d <= 4000 ? r.j : -1);
    baseMin.push(r && r.d <= 4000 ? +oneWay(r.d).toFixed(1) : -1);
  }
}
const taps = layout.taps;
const tapMin: number[] = [];
for (const c of clusters) for (const t of taps) {
  const d = dist(c.lon, c.lat, t[0], t[1]);
  tapMin.push(d <= 2200 ? +oneWay(d).toFixed(1) : -1);
}
const model: SimulationModel = {
  n, lon: clusters.map((c) => +c.lon.toFixed(6)), lat: clusters.map((c) => +c.lat.toFixed(6)),
  people: clusters.map((c) => +c.people.toFixed(1)), baseIdx, baseMin, existingCount: improved.length, replaces: -1,
  tapCount: taps.length, tapLon: taps.map((t) => t[0]), tapLat: taps.map((t) => t[1]), tapMin,
  perTapL: perTapDailyLitres(), yieldLowL: rec.output.dailyLitersLow, yieldHighL: rec.output.dailyLitersHigh,
  rain: null, rates: defaultRates(), weeks: 520,
};

const t0 = Date.now();
const stat = evaluateStatic(model).result;
const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
const outcomes = seeds.map((s) => runFuture(model, s));
const ms = Date.now() - t0;
const designed = stat.served;
const passed = outcomes.map((o) => o.peopleServed >= BEHAVIOUR.passThreshold.value * designed);
const mid = (rec.cost.totalLow + rec.cost.totalHigh) / 2;

const main: SimulationProject = {
  id: `${w.id}:solar_borehole`, candidateId: w.id, type: "solar_borehole", label: rec.label,
  anchor: "Drilled beside the road for rig access; groundwater evidence 0.70", source: layout.source,
  costLow: rec.cost.totalLow, costHigh: rec.cost.totalHigh, lifecycleCost: Math.round(mid * 1.3),
  dailyYieldLow: rec.output.dailyLitersLow, dailyYieldHigh: rec.output.dailyLitersHigh,
  tapCount: taps.length, pipelineLengthM: layout.pipelineLengthM,
  peopleServed: Math.round(stat.served), peopleUnder30Min: Math.round(stat.under30),
  minutesSavedPerTrip: +((stat.hoursSaved * 60) / Math.max(1, stat.served)).toFixed(1),
  hoursSavedPerDay: Math.round(stat.hoursSaved), costPerPersonServed: Math.round((mid * 1.3) / Math.max(1, stat.served)),
  futures: {
    run: seeds.length, passed: passed.filter(Boolean).length,
    peopleServed: summarise(outcomes.map((o) => o.peopleServed)),
    hoursSavedPerDay: summarise(outcomes.map((o) => o.hoursSavedPerDay)),
    weeksDown: summarise(outcomes.map((o) => o.weeksDown)),
    capacityYear: null,
  },
};
const variant = (id: string, type: SimulationProject["type"], label: string, f: number, held: number): SimulationProject => ({
  ...main, id: `${w.id}:${type}`, type, label, anchor: "DEV FIXTURE variant",
  costPerPersonServed: Math.round(main.costPerPersonServed * f), peopleServed: Math.round(main.peopleServed / f),
  futures: main.futures ? { ...main.futures, passed: held } : null,
});
const result: SimulationResult = {
  version: 1, screened: 1187, detailed: 14, stressTested: 6, futuresPerProject: seeds.length, weeksPerFuture: 520,
  householdClusters: n, buildings: clusters.length, buildingSource: "sample",
  projects: [main, variant("b", "borehole_rehabilitation", "Rehabilitation of the existing borehole", 1.4, 15), variant("c", "community_storage_and_taps", "Bulk-supplied community storage with tap stands", 2.6, 19)],
  recommendedId: main.id, layout,
  replay: { ...model, projectId: main.id, seeds, passed, designedServed: designed },
  assumptions: ["DEV FIXTURE: straight-line walking on the sampled buildings; replaced by the real pipeline output."],
};
writeFileSync("data/fixtures/simulation-dev.json", JSON.stringify(result));
run.simulation = result;
writeFileSync(RUN, JSON.stringify(run));
console.log({ clusters: n, existing: improved.length, taps: taps.length, designedServed: Math.round(designed), under30: Math.round(stat.under30), hoursSaved: Math.round(stat.hoursSaved), futuresMs: ms, perFutureMs: Math.round(ms / seeds.length), held: main.futures!.passed, served: main.futures!.peopleServed, weeksDown: main.futures!.weeksDown });
