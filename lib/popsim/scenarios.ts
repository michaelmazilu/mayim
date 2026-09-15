/**
 * The household simulation end to end, in three passes of rising cost:
 *
 *   screen    every ranked site x every system type it can physically take,
 *             on the town-wide building sample
 *   simulate  the best projects against full-detail households, with taps
 *             sited and pipes routed on the real walking network
 *   stress    the leaders across seeded ten-year futures
 *
 * The recommendation is the lowest whole-life cost per person served among
 * the projects that hold in at least BEHAVIOUR.robustShare of futures.
 */
import type {
  Candidate,
  ClimateData,
  InfrastructureType,
  OsmData,
  SimulationProject,
  SimulationRates,
  SimulationResult,
  TownRef,
} from "@/lib/types";
import { BEHAVIOUR, WATER } from "@/lib/config/coefficients";
import { buildRecommendation } from "@/lib/infrastructure/select";
import { lifecycleCost } from "@/lib/cost-model/lifecycle";
import { runFuture, SPEED_M_PER_MIN, WEEKS_PER_YEAR } from "@/lib/popsim/engine";
import { baselineRoundTrip, buildBaseline, improvedPoints } from "@/lib/popsim/baseline";
import { clusterBuildings, PEOPLE_PER_BUILDING } from "@/lib/popsim/demand";
import { evaluateProject, populationNear, SIZING_RADIUS_M, type Evaluated, type SimContext } from "@/lib/popsim/evaluate";
import { buildGraph, metres, scaleAt, snapMany } from "@/lib/popsim/network";
import { anchorFor, rawSourcesFrom, type Anchor } from "@/lib/popsim/placement";
import { quantile, summarise } from "@/lib/popsim/stats";
import type { Circle, LocalOsm } from "@/lib/providers/local-osm";
import type { LngLat } from "@/lib/types";

export type SimulationOptions = {
  maxScreenSites: number;
  detailProjects: number;
  circles: number;
  circleRadiusM: number;
  stressProjects: number;
  futures: number;
  weeks: number;
  /** Wall-clock budget for the full-detail map fetch. */
  fetchBudgetMs: number;
};

export const LIVE_OPTIONS: SimulationOptions = {
  maxScreenSites: 200,
  detailProjects: 14,
  circles: 2,
  circleRadiusM: 1600,
  stressProjects: 6,
  futures: 16,
  weeks: 520,
  fetchBudgetMs: 40_000,
};

export const PRECOMPUTE_OPTIONS: SimulationOptions = {
  maxScreenSites: 400,
  detailProjects: 40,
  circles: 5,
  circleRadiusM: 2000,
  stressProjects: 10,
  futures: 24,
  weeks: 520,
  fetchBudgetMs: 300_000,
};

export type SimulationInput = {
  town: TownRef;
  osm: OsmData;
  climate: ClimateData;
  candidates: Candidate[];
  ranked: string[];
  rates: SimulationRates;
  rateNotes?: string[];
};

export type SimulationDeps = {
  fetchLocal: (circles: Circle[], opts?: { buildings?: boolean; budgetMs?: number }) => Promise<LocalOsm>;
};
export type SimulationEmit = (message: string, sourceCount?: number) => void;
export type SimulationRun = { result: SimulationResult; best: Evaluated | null };

export const ALL_TYPES: InfrastructureType[] = [
  "solar_borehole",
  "borehole_rehabilitation",
  "rainwater_harvesting",
  "filtration_and_storage",
  "community_storage_and_taps",
];

/**
 * A project is simulated in detail only if its source sits this close to a
 * fetched circle's centre, so its taps and most of the people who could use
 * them lie inside the full-detail area.
 */
const ANCHOR_IN_CIRCLE_M = 600;
/** Sites this far from a circle's centre can still anchor a system inside it (a school, a well, a road). */
const SITE_SEARCH_M = 1400;
const SCREEN_DEMAND_M = 1200;
/** Taps sit between the tank and the households, so screening walks are shortened by this factor. */
const SCREEN_SPREAD = 0.75;
const MIN_SCREEN_SERVED = 40;
const DETOUR = BEHAVIOUR.detourFactor.value;
const LPD = WATER.litersPerPersonPerDay.value;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Screened = { candidate: Candidate; anchor: Anchor; served: number; costPerPerson: number };

function contextFrom(
  input: SimulationInput,
  points: { lon: number; lat: number }[],
  weight: number,
  lines: LngLat[][],
  weeks: number,
  routed: boolean,
): SimContext {
  const scale = scaleAt(input.town.center[1]);
  const clusters = clusterBuildings(points, weight, scale);
  const graph = buildGraph(lines, scale);
  const clusterSnap = routed && graph ? snapMany(graph, clusters.lon, clusters.lat, clusters.n) : null;
  const existing = improvedPoints(input.osm.waterPoints);
  const baseline = buildBaseline(clusters, existing, scale, routed ? graph : null, clusterSnap);
  return {
    scale,
    graph,
    clusters,
    baselineRt: baselineRoundTrip(clusters, baseline),
    existing,
    rawSources: rawSourcesFrom(input.osm),
    institutions: [...input.osm.schools, ...input.osm.clinics],
    town: input.town,
    osm: input.osm,
    climate: input.climate,
    baseline,
    clusterSnap,
    rates: input.rates,
    weeks,
  };
}

function screen(ctx: SimContext, cand: Candidate, type: InfrastructureType, years: number): Screened | null {
  const anchor = anchorFor(type, cand, ctx);
  if (!anchor) return null;
  const population = populationNear(ctx, anchor.lon, anchor.lat, SIZING_RADIUS_M);
  const rec = buildRecommendation({
    features: cand.features,
    climate: ctx.climate,
    population,
    hasNearbyMappedWaterPoint: type === "borehole_rehabilitation",
    pipelineLengthM: 900,
    tapStandCount: 3,
    forceType: type,
  });
  const capacityPeople = Math.floor((rec.output.dailyLitersLow + rec.output.dailyLitersHigh) / 2 / LPD);
  const c = ctx.clusters;
  let demand = 0;
  for (let i = 0; i < c.n; i++) {
    const d = metres(ctx.scale, anchor.lon, anchor.lat, c.lon[i], c.lat[i]);
    if (d > SCREEN_DEMAND_M) continue;
    if ((2 * d * SCREEN_SPREAD * DETOUR) / SPEED_M_PER_MIN < ctx.baselineRt[i]) demand += c.people[i];
  }
  const served = Math.min(capacityPeople, demand);
  if (served < MIN_SCREEN_SERVED) return null;
  const capex = (rec.cost.totalLow + rec.cost.totalHigh) / 2;
  return { candidate: cand, anchor, served, costPerPerson: lifecycleCost(type, capex, served * LPD, years).total / served };
}

const byValue = (a: SimulationProject, b: SimulationProject) =>
  a.costPerPersonServed - b.costPerPersonServed || b.hoursSavedPerDay - a.hoursSavedPerDay || (a.id < b.id ? -1 : 1);

function decide(stress: Evaluated[], futures: number): Evaluated | null {
  const need = Math.ceil(BEHAVIOUR.robustShare.value * futures);
  const passes = (e: Evaluated) => e.project.futures?.passed ?? 0;
  const robust = stress.filter((e) => passes(e) >= need).sort((a, b) => byValue(a.project, b.project));
  if (robust.length > 0) return robust[0];
  return [...stress].sort((a, b) => passes(b) - passes(a) || byValue(a.project, b.project))[0] ?? null;
}

function emptyResult(reason: string, screened: number, opts: SimulationOptions): SimulationResult {
  return {
    version: 1,
    screened,
    detailed: 0,
    stressTested: 0,
    futuresPerProject: opts.futures,
    weeksPerFuture: opts.weeks,
    householdClusters: 0,
    buildings: 0,
    buildingSource: "sample",
    projects: [],
    recommendedId: null,
    layout: null,
    replay: null,
    assumptions: [reason],
  };
}

function assumptions(
  ctx: SimContext,
  source: SimulationResult["buildingSource"],
  opts: SimulationOptions,
  notes: string[],
): string[] {
  const r = ctx.rates;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return [
    `Households: ${ctx.clusters.buildings.toLocaleString("en-US")} mapped buildings (${source === "full" ? "every building OpenStreetMap has in the analysis area" : source === "local" ? "every building OpenStreetMap has around the shortlisted sites" : "the capped town-wide OpenStreetMap sample, scaled up; the full-detail fetch failed"}) grouped into ${ctx.clusters.n.toLocaleString("en-US")} clusters of 50 m, at ${PEOPLE_PER_BUILDING} people per building and ${LPD} L per person per day.`,
    `Today: each cluster walks to its nearest well, borehole, spring or drinking-water tap along mapped streets and footpaths at ${BEHAVIOUR.walkingSpeedKmh.value} km/h. Clusters with none within reach are assumed to spend ${BEHAVIOUR.noSourceRoundTripMinutes.value} minutes per round trip at an unmapped source.`,
    `New taps are sited one at a time where they save the most walking for people not yet served, ${BEHAVIOUR.peoplePerTap.value} people each (${BEHAVIOUR.peoplePerTap.source}); queues follow from a ${BEHAVIOUR.tapFlowLitresPerMinute.value} L/min tap. Pipes follow the streets from the tank.`,
    `A cluster uses a new tap only when its round trip, queue included, beats today's. Queues at existing points are not modelled because their real capacity is unmapped.`,
    `Futures: ${opts.futures} seeded ten-year runs per stress-tested project. Existing points are out of service ${pct(r.shareExisting)} of the time, the new system ${pct(BEHAVIOUR.nonFunctionalShare.project)}; repairs take ${r.repairLow}-${r.repairHigh} weeks; households grow ${(r.growth * 100).toFixed(1)}% a year; rainfall varies up to ${pct(BEHAVIOUR.rainfallYearVariation.value)} a year and rainwater storage is simulated week by week.`,
    `A future holds when people served over ten years average at least ${pct(BEHAVIOUR.passThreshold.value)} of the design figure. The recommendation is the lowest whole-life cost per person served among projects that hold in at least ${pct(BEHAVIOUR.robustShare.value)} of futures.`,
    `Whole-life cost is capital plus ${BEHAVIOUR.horizonYears.value} years of operation and maintenance, including trucked water and filter consumables where they apply (${BEHAVIOUR.horizonYears.source.toLowerCase()} planning figures).`,
    ...notes,
  ];
}

export async function runSimulation(
  input: SimulationInput,
  opts: SimulationOptions,
  deps: SimulationDeps,
  emit: SimulationEmit = () => {},
): Promise<SimulationRun> {
  const years = BEHAVIOUR.horizonYears.value;
  const byId = new Map(input.candidates.map((c) => [c.id, c]));
  const sites = input.ranked
    .map((id) => byId.get(id))
    .filter((c): c is Candidate => Boolean(c) && !c!.excluded)
    .slice(0, opts.maxScreenSites);

  // 1. Screen every site and every system type it can physically take.
  const sample = contextFrom(
    input,
    input.osm.buildings,
    Math.max(1, input.osm.buildingSampleRatio || 1),
    input.osm.roads.map((r) => r.coords),
    opts.weeks,
    false,
  );
  const bestByKey = new Map<string, Screened>();
  let screenedCount = 0;
  for (const cand of sites) {
    for (const type of ALL_TYPES) {
      const s = screen(sample, cand, type, years);
      if (!s) continue;
      screenedCount++;
      const prev = bestByKey.get(s.anchor.key);
      if (!prev || s.costPerPerson < prev.costPerPerson) bestByKey.set(s.anchor.key, s);
    }
  }
  const screened = [...bestByKey.values()].sort(
    (a, b) => a.costPerPerson - b.costPerPerson || (a.anchor.key < b.anchor.key ? -1 : 1),
  );
  emit(`Screened ${screenedCount} site and system pairs`, screenedCount);
  if (screened.length === 0) {
    return { result: emptyResult("No site could take any system type with enough demand to simulate.", screenedCount, opts), best: null };
  }

  // 2. Decide where to look closely. Paths are fetched around the leading
  //    sources; buildings come from the town query when it kept all of them.
  const full = input.osm.full && input.osm.full.buildings.length > 0 ? input.osm.full : null;
  const circles: Circle[] = [];
  for (const s of screened) {
    if (circles.length >= opts.circles) break;
    const distinct = circles.every((c) => metres(sample.scale, c.lon, c.lat, s.anchor.lon, s.anchor.lat) > opts.circleRadiusM * 0.6);
    if (distinct) circles.push({ lon: s.anchor.lon, lat: s.anchor.lat, radiusM: opts.circleRadiusM });
  }
  const inCircle = (a: Anchor) => circles.some((c) => metres(sample.scale, c.lon, c.lat, a.lon, a.lat) <= ANCHOR_IN_CIRCLE_M);
  const eligible = (a: Anchor) => Boolean(full) || inCircle(a);
  const detail = screened.filter((s) => eligible(s.anchor)).slice(0, opts.detailProjects);
  for (const type of ALL_TYPES) {
    if (detail.some((d) => d.anchor.type === type)) continue;
    const extra = screened.find((s) => s.anchor.type === type && eligible(s.anchor));
    if (extra) detail.push(extra);
  }

  emit(`Fetching every footpath${full ? "" : " and building"} around ${circles.length} sites`, circles.length);
  const local = await deps.fetchLocal(circles, { buildings: !full, budgetMs: opts.fetchBudgetMs });
  const lines = [...local.paths, ...(full ? full.roads : input.osm.roads.map((r) => r.coords))];
  const buildingSource: SimulationResult["buildingSource"] = full ? "full" : local.ok ? "local" : "sample";
  const ctx =
    buildingSource === "full"
      ? contextFrom(input, full!.buildings, 1, lines, opts.weeks, true)
      : buildingSource === "local"
        ? contextFrom(input, local.buildings, local.buildingWeight, lines, opts.weeks, true)
        : contextFrom(input, input.osm.buildings, Math.max(1, input.osm.buildingSampleRatio || 1), lines, opts.weeks, true);
  const restrict = buildingSource === "local";
  emit(`${ctx.clusters.n.toLocaleString("en-US")} household clusters from ${ctx.clusters.buildings.toLocaleString("en-US")} buildings`, ctx.clusters.n);

  // 3. Inside each full-detail area, every nearby site and every system type
  //    it can anchor becomes a project: the borehole by the road, the tank on
  //    the school roof, the well that could be restored, the filter at the
  //    reservoir. Then each is simulated against every household cluster.
  const jobs: { candidate: Candidate; anchor: Anchor }[] = [];
  const seen = new Set<string>();
  const addJob = (candidate: Candidate, anchor: Anchor | null) => {
    if (!anchor || seen.has(anchor.key) || (restrict && !inCircle(anchor))) return;
    seen.add(anchor.key);
    jobs.push({ candidate, anchor });
  };
  for (const d of detail) addJob(d.candidate, anchorFor(d.anchor.type, d.candidate, ctx) ?? d.anchor);
  for (const circle of circles) {
    for (const cand of sites) {
      if (metres(ctx.scale, circle.lon, circle.lat, cand.lon, cand.lat) > SITE_SEARCH_M) continue;
      for (const type of ALL_TYPES) addJob(cand, anchorFor(type, cand, ctx));
    }
  }
  const evaluated: Evaluated[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const ev = evaluateProject(ctx, jobs[i].candidate, jobs[i].anchor);
    if (ev && ev.project.peopleServed > 0) evaluated.push(ev);
    if (i % 4 === 3) await tick();
  }
  evaluated.sort((a, b) => byValue(a.project, b.project));
  emit(`Simulated ${evaluated.length} projects household by household`, evaluated.length);
  if (evaluated.length === 0) {
    return { result: emptyResult("No shortlisted project served anyone once households were simulated in detail.", screenedCount, opts), best: null };
  }

  // 4. Stress the leaders across seeded futures.
  const seeds = Array.from({ length: opts.futures }, (_, k) => 7919 + k * 104729);
  const stress = evaluated.slice(0, opts.stressProjects);
  const horizon = Math.ceil(opts.weeks / WEEKS_PER_YEAR);
  for (const ev of stress) {
    const outs = seeds.map((seed) => runFuture(ev.model, seed));
    ev.passed = outs.map((o) => o.peopleServed >= BEHAVIOUR.passThreshold.value * ev.designedServed);
    const cap = quantile(outs.map((o) => o.capacityYear ?? horizon + 1), 0.5);
    ev.project.futures = {
      run: seeds.length,
      passed: ev.passed.filter(Boolean).length,
      peopleServed: summarise(outs.map((o) => o.peopleServed)),
      hoursSavedPerDay: summarise(outs.map((o) => o.hoursSavedPerDay)),
      weeksDown: summarise(outs.map((o) => o.weeksDown)),
      capacityYear: cap > horizon ? null : Math.round(cap),
    };
    await tick();
  }
  const best = decide(stress, opts.futures);
  if (best?.project.futures) {
    emit(`${best.project.label} · held in ${best.project.futures.passed}/${best.project.futures.run} futures`, best.project.futures.run);
  }

  const need = Math.ceil(BEHAVIOUR.robustShare.value * opts.futures);
  const passes = (e: Evaluated) => e.project.futures?.passed ?? 0;
  const stressOrder = [...stress].sort((a, b) => {
    if (a === best) return -1;
    if (b === best) return 1;
    const ra = passes(a) >= need ? 0 : 1;
    const rb = passes(b) >= need ? 0 : 1;
    return ra - rb || (ra === 0 ? byValue(a.project, b.project) : passes(b) - passes(a) || byValue(a.project, b.project));
  });
  const projects = [...stressOrder, ...evaluated.slice(opts.stressProjects)].map((e) => e.project);

  return {
    best,
    result: {
      version: 1,
      screened: screenedCount,
      detailed: evaluated.length,
      stressTested: stress.length,
      futuresPerProject: opts.futures,
      weeksPerFuture: opts.weeks,
      householdClusters: ctx.clusters.n,
      buildings: ctx.clusters.buildings,
      buildingSource,
      projects,
      recommendedId: best?.project.id ?? null,
      layout: best?.layout ?? null,
      replay: best
        ? { ...best.model, projectId: best.project.id, seeds, passed: best.passed, designedServed: Math.round(best.designedServed) }
        : null,
      assumptions: assumptions(ctx, buildingSource, opts, [...(input.rateNotes ?? []), ...(local.ok ? [] : ["Full-detail footpaths could not be fetched; walking follows the mapped roads only."])]),
    },
  };
}
