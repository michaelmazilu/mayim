/**
 * One project, evaluated against every household cluster within reach:
 * anchor it, size it, site its taps, route its pipes, cost it, and measure
 * the design case. Returns the SimulationModel the futures and the browser
 * replay run on, so every number shown traces back to one object.
 */
import type {
  Candidate,
  ClimateData,
  ConceptualLayoutData,
  InfrastructureRecommendation,
  OsmData,
  PopulationEstimate,
  SimulationModel,
  SimulationProject,
  SimulationRates,
  TownRef,
} from "@/lib/types";
import { BEHAVIOUR, WATER } from "@/lib/config/coefficients";
import { buildRecommendation } from "@/lib/infrastructure/select";
import { lifecycleCost } from "@/lib/cost-model/lifecycle";
import { evaluateStatic, K, perTapDailyLitres, SPEED_M_PER_MIN } from "@/lib/popsim/engine";
import type { BaselineTable } from "@/lib/popsim/baseline";
import { ratesForType } from "@/lib/popsim/sourced-rates";
import { dijkstra, metres } from "@/lib/popsim/network";
import { buildLayout, MAX_TAPS, placeTaps, routePipes, type Anchor, type PlaceCtx } from "@/lib/popsim/placement";

export type SimContext = PlaceCtx & {
  town: TownRef;
  osm: OsmData;
  climate: ClimateData;
  baseline: BaselineTable;
  clusterSnap: { node: Int32Array; offsetM: Float64Array } | null;
  rates: SimulationRates;
  weeks: number;
};

export type Evaluated = {
  project: SimulationProject;
  model: SimulationModel;
  layout: ConceptualLayoutData;
  recommendation: InfrastructureRecommendation;
  population: PopulationEstimate;
  anchor: Anchor;
  designedServed: number;
  passed: boolean[];
};

/** Beyond this a new tap cannot beat the fallback round trip, so clusters are left out. */
const MODEL_RADIUS_M = 2000;
const TAP_ROUTE_CUTOFF_M = 2600;
export const SIZING_RADIUS_M = 1000;
const MIN_CAPACITY_PEOPLE = 20;
const DETOUR = BEHAVIOUR.detourFactor.value;
const LPD = WATER.litersPerPersonPerDay.value;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function populationNear(ctx: PlaceCtx, lon: number, lat: number, radiusM: number): PopulationEstimate {
  const c = ctx.clusters;
  let people = 0;
  for (let i = 0; i < c.n; i++) {
    if (metres(ctx.scale, lon, lat, c.lon[i], c.lat[i]) <= radiusM) people += c.people[i];
  }
  const p = Math.round(people);
  return {
    peopleServed: p,
    rangeLow: Math.round(p * 0.7),
    rangeHigh: Math.round(p * 1.3),
    serviceRadiusM: radiusM,
    method: "building_density_proxy",
    methodLabel: `About ${Math.round(people / c.peoplePerBuilding).toLocaleString("en-US")} mapped buildings within ${radiusM} m of the water source, at ${c.peoplePerBuilding} people per building.`,
    confidence: 0.5,
    limitations: [
      "Every mapped building is treated as one household; shops, sheds and institutions inflate the count and unmapped homes deflate it.",
      "OpenStreetMap building coverage is uneven between neighbourhoods.",
    ],
  };
}

function buildModel(
  ctx: SimContext,
  anchor: Anchor,
  taps: { lon: number; lat: number; node: number }[],
  rec: InfrastructureRecommendation,
): SimulationModel {
  const c = ctx.clusters;
  const s = ctx.scale;
  const sel: number[] = [];
  for (let i = 0; i < c.n; i++) {
    if (metres(s, anchor.lon, anchor.lat, c.lon[i], c.lat[i]) <= MODEL_RADIUS_M) sel.push(i);
  }
  const T = taps.length;
  const tapDist = taps.map((t) =>
    ctx.graph && t.node >= 0 ? dijkstra(ctx.graph, [{ node: t.node, d: 0, label: 0 }], TAP_ROUTE_CUTOFF_M).dist : null,
  );

  const lon: number[] = [];
  const lat: number[] = [];
  const people: number[] = [];
  const baseIdx: number[] = [];
  const baseMin: number[] = [];
  const tapMin: number[] = [];
  for (const i of sel) {
    lon.push(r6(c.lon[i]));
    lat.push(r6(c.lat[i]));
    people.push(r1(c.people[i]));
    for (let k = 0; k < K; k++) {
      baseIdx.push(ctx.baseline.idx[i * K + k]);
      const m = ctx.baseline.oneWay[i * K + k];
      baseMin.push(m >= 0 ? r1(m) : -1);
    }
    const node = ctx.clusterSnap ? ctx.clusterSnap.node[i] : -1;
    for (let t = 0; t < T; t++) {
      const dist = tapDist[t];
      let minutes = -1;
      if (dist && node >= 0 && Number.isFinite(dist[node])) {
        minutes = (ctx.clusterSnap!.offsetM[i] + dist[node]) / SPEED_M_PER_MIN;
      } else {
        const d = metres(s, c.lon[i], c.lat[i], taps[t].lon, taps[t].lat);
        if (d <= TAP_ROUTE_CUTOFF_M) minutes = (d * DETOUR) / SPEED_M_PER_MIN;
      }
      tapMin.push(minutes >= 0 ? r1(minutes) : -1);
    }
  }

  return {
    n: sel.length,
    lon,
    lat,
    people,
    baseIdx,
    baseMin,
    existingCount: ctx.existing.length,
    replaces: anchor.replaces,
    tapCount: T,
    tapLon: taps.map((t) => r6(t.lon)),
    tapLat: taps.map((t) => r6(t.lat)),
    tapMin,
    perTapL: perTapDailyLitres(),
    yieldLowL: rec.output.dailyLitersLow,
    yieldHighL: rec.output.dailyLitersHigh,
    rain:
      rec.type === "rainwater_harvesting"
        ? {
            catchmentM2: rec.catchmentM2 ?? 0,
            storageL: rec.storageLiters ?? 0,
            monthlyMmDay: ctx.climate.monthlyRainfallMmDay.slice(0, 12).map((v) => r1(Math.max(0, v))),
            runoff: WATER.runoffCoefficient,
          }
        : null,
    rates: ratesForType(ctx.rates, rec.type),
    weeks: ctx.weeks,
  };
}

export function evaluateProject(ctx: SimContext, cand: Candidate, anchor: Anchor): Evaluated | null {
  const type = anchor.type;
  const population = populationNear(ctx, anchor.lon, anchor.lat, SIZING_RADIUS_M);
  const base = {
    features: cand.features,
    climate: ctx.climate,
    population,
    hasNearbyMappedWaterPoint: type === "borehole_rehabilitation",
    forceType: type,
  };
  const first = buildRecommendation({ ...base, pipelineLengthM: 800, tapStandCount: 3 });
  const yieldMid = (first.output.dailyLitersLow + first.output.dailyLitersHigh) / 2;
  const capacityPeople = Math.floor(yieldMid / LPD);
  if (capacityPeople < MIN_CAPACITY_PEOPLE) return null;

  const K_TAPS = Math.min(MAX_TAPS[type], Math.max(1, Math.ceil(capacityPeople / BEHAVIOUR.peoplePerTap.value)));
  const taps = placeTaps(ctx, anchor, K_TAPS, capacityPeople);
  if (taps.length === 0) return null;
  const routed = routePipes(ctx, anchor, taps);
  const layout = buildLayout(anchor, taps, routed);
  const recommendation = buildRecommendation({
    ...base,
    pipelineLengthM: layout.pipelineLengthM,
    tapStandCount: layout.tapStandCount,
  });

  const model = buildModel(ctx, anchor, taps, recommendation);
  const stat = evaluateStatic(model).result;
  const capexMid = (recommendation.cost.totalLow + recommendation.cost.totalHigh) / 2;
  const lc = lifecycleCost(type, capexMid, stat.systemLoadL, BEHAVIOUR.horizonYears.value);
  const served = stat.served;

  const project: SimulationProject = {
    id: `${cand.id}:${type}`,
    candidateId: cand.id,
    type,
    label: recommendation.label,
    anchor: anchor.label,
    source: layout.source,
    costLow: recommendation.cost.totalLow,
    costHigh: recommendation.cost.totalHigh,
    lifecycleCost: lc.total,
    dailyYieldLow: recommendation.output.dailyLitersLow,
    dailyYieldHigh: recommendation.output.dailyLitersHigh,
    tapCount: layout.tapStandCount,
    pipelineLengthM: layout.pipelineLengthM,
    peopleServed: Math.round(served),
    peopleUnder30Min: Math.round(stat.under30),
    minutesSavedPerTrip: r1((stat.hoursSaved * 60) / Math.max(1, served)),
    hoursSavedPerDay: Math.round(stat.hoursSaved),
    costPerPersonServed: Math.round(lc.total / Math.max(1, served)),
    futures: null,
  };
  return { project, model, layout, recommendation, population, anchor, designedServed: served, passed: [] };
}
