/**
 * The household simulation engine.
 *
 * Pure and dependency-free apart from the coefficient table, so the server
 * (static evaluation, futures) and the browser (live replay) run the same code.
 * One SimulationModel describes one project; a World is its typed working copy;
 * a Future steps that world week by week under one seed.
 *
 * The decision rule: every household cluster, nearest to a tap first, fetches
 * from whichever working source gives the shortest round trip including the
 * queue. Taps have two limits, their own dispensing rate and the system's
 * daily yield, and demand that does not fit falls back to the household's
 * current source. Existing points are walk-only: their real capacity is not
 * mapped, and inventing queues there would flatter the project.
 */
import type { SimulationModel, SimulationRates } from "@/lib/types";
import { BEHAVIOUR, WATER } from "@/lib/config/coefficients";
import { createRng, type Rng } from "@/lib/popsim/rng";

export const K = 3;
export const WEEKS_PER_YEAR = 52;

const LPD = WATER.litersPerPersonPerDay.value;
const TRIPS_PER_PERSON_DAY = LPD / BEHAVIOUR.containerLitres.value;
export const SPEED_M_PER_MIN = (BEHAVIOUR.walkingSpeedKmh.value * 1000) / 60;
const SERVICE_MIN = BEHAVIOUR.containerLitres.value / BEHAVIOUR.tapFlowLitresPerMinute.value;
const MAX_WAIT = BEHAVIOUR.maxWaitMinutes.value;
const NO_SOURCE = BEHAVIOUR.noSourceRoundTripMinutes.value;
const BASIC = BEHAVIOUR.basicServiceRoundTripMinutes.value;
const SATURATION = 0.95;
const QUEUE_SMOOTHING = 0.5;
const GROWTH_HEADROOM = 1.8;
const SPAWN_MIN_M = 60;
const SPAWN_MAX_M = 200;
const M_PER_DEG_LAT = 111_320;

/** Daily litres one tap stand can dispense at the planning service level. */
export function perTapDailyLitres(): number {
  return BEHAVIOUR.peoplePerTap.value * LPD;
}

/** Mean wait at a tap: a single server with fixed service time, capped. */
export function queueMinutes(loadL: number, perTapL: number): number {
  if (!(perTapL > 0)) return MAX_WAIT;
  const u = Math.min(0.97, Math.max(0, loadL / perTapL));
  return Math.min(MAX_WAIT, (SERVICE_MIN * u) / (2 * (1 - u)));
}

/**
 * Weekly failure probability from a long-run out-of-service share: a source
 * that fails with weekly probability p and takes r weeks to fix is down
 * p*r / (1 + p*r) of the time, so p = s / (r * (1 - s)).
 */
export function ratesFromShares(
  shareExisting: number,
  shareProject: number,
  repairLow: number,
  repairHigh: number,
  growth: number,
): SimulationRates {
  const meanRepair = Math.max(1, (repairLow + repairHigh) / 2);
  const weekly = (s: number) => (s <= 0 ? 0 : Math.min(1, s / (meanRepair * (1 - Math.min(0.95, s)))));
  return {
    failExisting: weekly(shareExisting),
    failProject: weekly(shareProject),
    shareExisting,
    repairLow,
    repairHigh,
    growth,
  };
}

export function defaultRates(): SimulationRates {
  return ratesFromShares(
    BEHAVIOUR.nonFunctionalShare.existing,
    BEHAVIOUR.nonFunctionalShare.project,
    BEHAVIOUR.repairWeeks.low,
    BEHAVIOUR.repairWeeks.high,
    BEHAVIOUR.annualGrowthRate.value,
  );
}

// ---------------------------------------------------------------------------
// World: typed working copy of a model
// ---------------------------------------------------------------------------

export class World {
  n: number;
  readonly cap: number;
  readonly T: number;
  readonly existingCount: number;
  readonly replaces: number;
  readonly perTapL: number;
  lon: Float64Array;
  lat: Float64Array;
  people: Float64Array;
  baseIdx: Int32Array;
  baseMin: Float64Array;
  tapMin: Float64Array;
  order: Int32Array;

  constructor(m: SimulationModel, headroom = GROWTH_HEADROOM) {
    this.n = m.n;
    this.cap = Math.max(1, Math.ceil(m.n * Math.max(1, headroom)));
    this.T = m.tapCount;
    this.existingCount = m.existingCount;
    this.replaces = m.replaces;
    this.perTapL = m.perTapL;
    this.lon = new Float64Array(this.cap);
    this.lat = new Float64Array(this.cap);
    this.people = new Float64Array(this.cap);
    this.baseIdx = new Int32Array(this.cap * K).fill(-1);
    this.baseMin = new Float64Array(this.cap * K).fill(-1);
    this.tapMin = new Float64Array(this.cap * Math.max(1, this.T)).fill(-1);
    this.lon.set(m.lon.slice(0, m.n));
    this.lat.set(m.lat.slice(0, m.n));
    this.people.set(m.people.slice(0, m.n));
    this.baseIdx.set(m.baseIdx.slice(0, m.n * K));
    this.baseMin.set(m.baseMin.slice(0, m.n * K));
    if (this.T > 0) this.tapMin.set(m.tapMin.slice(0, m.n * this.T));
    this.order = new Int32Array(0);
    this.reorder();
  }

  /** Nearest reachable tap first; clusters that cannot reach any tap go last. */
  reorder(): void {
    const n = this.n;
    const T = this.T;
    const key = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (let t = 0; t < T; t++) {
        const v = this.tapMin[i * T + t];
        if (v >= 0 && v < best) best = v;
      }
      key[i] = best;
    }
    const order = Int32Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => key[a] - key[b] || a - b);
    this.order = order;
  }

  /** A new cluster beside a parent inherits the parent's walks plus the extra distance. */
  addCluster(parent: number, lon: number, lat: number, people: number, extraOneWay: number): boolean {
    if (this.n >= this.cap) return false;
    const i = this.n++;
    this.lon[i] = lon;
    this.lat[i] = lat;
    this.people[i] = people;
    for (let k = 0; k < K; k++) {
      this.baseIdx[i * K + k] = this.baseIdx[parent * K + k];
      const b = this.baseMin[parent * K + k];
      this.baseMin[i * K + k] = b >= 0 ? b + extraOneWay : -1;
    }
    for (let t = 0; t < this.T; t++) {
      const v = this.tapMin[parent * this.T + t];
      this.tapMin[i * this.T + t] = v >= 0 ? v + extraOneWay : -1;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// One week of choices
// ---------------------------------------------------------------------------

export type SourceState = {
  systemUp: boolean;
  existingUp: Uint8Array;
  /** Litres per day the system can supply this week. */
  systemCapL: number;
  /** Expected queue at each tap, minutes. */
  queue: Float64Array;
};

export type WeekResult = {
  /** Per cluster: round trip in minutes, a people-weighted mix of taps and the fallback. */
  minutes: Float64Array;
  /** Per cluster: share of its demand met by the project. */
  servedFrac: Float64Array;
  /** Per cluster: round trip with no project at all. */
  baseline: Float64Array;
  tapLoadL: Float64Array;
  systemLoadL: number;
  served: number;
  under30: number;
  hoursSaved: number;
  saturated: boolean;
};

export function newWeekResult(cap: number, T: number): WeekResult {
  return {
    minutes: new Float64Array(cap),
    servedFrac: new Float64Array(cap),
    baseline: new Float64Array(cap),
    tapLoadL: new Float64Array(Math.max(1, T)),
    systemLoadL: 0,
    served: 0,
    under30: 0,
    hoursSaved: 0,
    saturated: false,
  };
}

function bestExisting(w: World, i: number, up: Uint8Array, includeReplaced: boolean): number {
  let best = NO_SOURCE;
  for (let k = 0; k < K; k++) {
    const j = w.baseIdx[i * K + k];
    if (j < 0 || !up[j]) continue;
    if (j === w.replaces && !includeReplaced) continue;
    const one = w.baseMin[i * K + k];
    if (one >= 0 && 2 * one < best) best = 2 * one;
  }
  return best;
}

export function assignWeek(w: World, s: SourceState, out?: WeekResult): WeekResult {
  const r = out ?? newWeekResult(w.cap, w.T);
  const T = w.T;
  r.tapLoadL.fill(0);
  r.systemLoadL = 0;
  r.served = 0;
  r.under30 = 0;
  r.hoursSaved = 0;

  const tapRemain = new Float64Array(Math.max(1, T));
  let systemRemain = 0;
  if (s.systemUp && s.systemCapL > 0) {
    tapRemain.fill(w.perTapL);
    systemRemain = s.systemCapL;
  }
  const replaced = w.replaces >= 0;

  for (let k = 0; k < w.n; k++) {
    const i = w.order[k];
    const base = bestExisting(w, i, s.existingUp, false);
    const base0 = replaced ? bestExisting(w, i, s.existingUp, true) : base;
    const people = w.people[i];
    const demand = people * LPD;
    let remaining = demand;
    let frac = 0;
    let mix = 0;
    let used = 0;

    if (systemRemain > 0 && demand > 0) {
      for (let iter = 0; iter < T; iter++) {
        let best = -1;
        let bestRt = base;
        for (let t = 0; t < T; t++) {
          if (used & (1 << t)) continue;
          if (tapRemain[t] <= 0) continue;
          const one = w.tapMin[i * T + t];
          if (one < 0) continue;
          const rt = 2 * one + s.queue[t];
          if (rt < bestRt) {
            bestRt = rt;
            best = t;
          }
        }
        if (best < 0) break;
        const take = Math.min(remaining, tapRemain[best], systemRemain);
        if (take <= 0) break;
        tapRemain[best] -= take;
        systemRemain -= take;
        r.tapLoadL[best] += take;
        r.systemLoadL += take;
        const f = take / demand;
        frac += f;
        mix += f * bestRt;
        if (bestRt <= BASIC) r.under30 += people * f;
        remaining -= take;
        used |= 1 << best;
        if (remaining <= 1e-9 || systemRemain <= 0) break;
      }
    }

    const minutes = mix + (1 - frac) * base;
    r.minutes[i] = minutes;
    r.servedFrac[i] = frac;
    r.baseline[i] = base0;
    r.served += people * frac;
    r.hoursSaved += (people * TRIPS_PER_PERSON_DAY * (base0 - minutes)) / 60;
  }

  const binding = Math.min(s.systemCapL, T * w.perTapL);
  r.saturated = s.systemUp && binding > 0 && r.systemLoadL >= SATURATION * binding;
  return r;
}

export function updateQueue(queue: Float64Array, loadL: Float64Array, perTapL: number, weight: number): void {
  for (let t = 0; t < queue.length; t++) {
    queue[t] = (1 - weight) * queue[t] + weight * queueMinutes(loadL[t], perTapL);
  }
}

/** Litres per day the system supplies in a typical week with everything working. */
export function designCapacityL(m: SimulationModel): number {
  return (m.yieldLowL + m.yieldHighL) / 2;
}

/**
 * Week zero with every source working: the design case. The queue is solved
 * as a damped fixed point, because who queues where depends on the queue.
 */
export function evaluateStatic(m: SimulationModel): { world: World; result: WeekResult; queue: Float64Array } {
  const world = new World(m, 1);
  const state: SourceState = {
    systemUp: true,
    existingUp: new Uint8Array(Math.max(1, m.existingCount)).fill(1),
    systemCapL: designCapacityL(m),
    queue: new Float64Array(Math.max(1, m.tapCount)),
  };
  let result = assignWeek(world, state);
  for (let pass = 0; pass < 6; pass++) {
    updateQueue(state.queue, result.tapLoadL, m.perTapL, QUEUE_SMOOTHING);
    result = assignWeek(world, state, result);
  }
  return { world, result, queue: state.queue };
}

// ---------------------------------------------------------------------------
// One seeded future
// ---------------------------------------------------------------------------

export type FutureFrame = {
  week: number;
  year: number;
  month: number;
  systemUp: boolean;
  capacityL: number;
  storageL: number | null;
  existingDown: number;
  result: WeekResult;
};

export type FutureOutcome = {
  peopleServed: number;
  hoursSavedPerDay: number;
  peopleUnder30Min: number;
  weeksDown: number;
  capacityYear: number | null;
  clustersAtEnd: number;
};

export class Future {
  readonly model: SimulationModel;
  readonly world: World;
  week = 0;
  private readonly rng: Rng;
  private readonly state: SourceState;
  private readonly repairExisting: Int32Array;
  private readonly result: WeekResult;
  private readonly satWeeks: Int32Array;
  private repairSystem = 0;
  private yieldL: number;
  private level = 0;
  private yearFactor = 1;
  private servedSum = 0;
  private hoursSum = 0;
  private under30Sum = 0;
  private weeksDown = 0;

  constructor(model: SimulationModel, seed: number) {
    this.model = model;
    this.world = new World(model);
    this.rng = createRng(seed);
    this.result = newWeekResult(this.world.cap, this.world.T);
    this.satWeeks = new Int32Array(Math.ceil(model.weeks / WEEKS_PER_YEAR) + 1);
    const rates = model.rates;

    this.yieldL = model.rain ? 0 : this.rng.range(model.yieldLowL, model.yieldHighL);
    const existingUp = new Uint8Array(Math.max(1, model.existingCount)).fill(1);
    this.repairExisting = new Int32Array(existingUp.length);
    for (let j = 0; j < model.existingCount; j++) {
      if (this.rng.next() < rates.shareExisting) {
        existingUp[j] = 0;
        this.repairExisting[j] = this.rng.int(1, Math.max(1, rates.repairHigh));
      }
    }
    this.state = {
      systemUp: true,
      existingUp,
      systemCapL: 0,
      queue: new Float64Array(Math.max(1, model.tapCount)),
    };

    if (model.rain) {
      // One climatological year of filling and drawing, so week zero starts
      // with the tank where this season would really have left it.
      const r = model.rain;
      const draw = Math.min(model.tapCount * model.perTapL, model.yieldHighL) * 7;
      this.level = r.storageL / 2;
      for (let w = 0; w < WEEKS_PER_YEAR; w++) {
        const month = Math.floor(((w % WEEKS_PER_YEAR) / WEEKS_PER_YEAR) * 12);
        const avail = this.level + r.catchmentM2 * r.monthlyMmDay[month] * 7 * r.runoff;
        this.level = Math.min(r.storageL, Math.max(0, avail - Math.min(avail, draw)));
      }
    }

    // Warm start the queues from the design case.
    this.state.systemCapL = model.rain ? designCapacityL(model) : this.yieldL;
    for (let pass = 0; pass < 4; pass++) {
      assignWeek(this.world, this.state, this.result);
      updateQueue(this.state.queue, this.result.tapLoadL, model.perTapL, QUEUE_SMOOTHING);
    }
  }

  get done(): boolean {
    return this.week >= this.model.weeks;
  }

  private grow(): void {
    const w = this.world;
    const g = this.model.rates.growth;
    if (!(g > 0) || w.n === 0) return;
    let total = 0;
    for (let i = 0; i < w.n; i++) total += w.people[i];
    if (!(total > 0)) return;
    const add = total * g;
    const sprawl = add * BEHAVIOUR.sprawlShare.value;
    const densify = add - sprawl;
    const scale = 1 + densify / total;
    for (let i = 0; i < w.n; i++) w.people[i] *= scale;

    const avg = total / w.n;
    const count = Math.min(w.cap - w.n, Math.max(1, Math.round(sprawl / avg)));
    if (count <= 0) {
      const scale2 = 1 + sprawl / (total + densify);
      for (let i = 0; i < w.n; i++) w.people[i] *= scale2;
      return;
    }
    const per = sprawl / count;
    const parents = w.n;
    const cum = new Float64Array(parents);
    let acc = 0;
    for (let i = 0; i < parents; i++) {
      acc += w.people[i];
      cum[i] = acc;
    }
    const detour = BEHAVIOUR.detourFactor.value;
    for (let c = 0; c < count; c++) {
      const target = this.rng.next() * acc;
      let lo = 0;
      let hi = parents - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const parent = lo;
      const d = this.rng.range(SPAWN_MIN_M, SPAWN_MAX_M);
      const theta = this.rng.next() * 2 * Math.PI;
      const lat = w.lat[parent] + (d * Math.sin(theta)) / M_PER_DEG_LAT;
      const lon =
        w.lon[parent] +
        (d * Math.cos(theta)) / (M_PER_DEG_LAT * Math.max(0.05, Math.cos((w.lat[parent] * Math.PI) / 180)));
      w.addCluster(parent, lon, lat, per, (d * detour) / SPEED_M_PER_MIN);
    }
    w.reorder();
  }

  step(): FutureFrame {
    const m = this.model;
    const rates = m.rates;
    const rng = this.rng;
    const s = this.state;

    if (this.week % WEEKS_PER_YEAR === 0) {
      if (this.week > 0) this.grow();
      if (m.rain) {
        const v = BEHAVIOUR.rainfallYearVariation.value;
        this.yearFactor = 1 + v * (2 * rng.next() - 1);
      }
    }

    if (s.systemUp) {
      if (rng.next() < rates.failProject) {
        s.systemUp = false;
        this.repairSystem = rng.int(rates.repairLow, rates.repairHigh);
      }
    } else if (--this.repairSystem <= 0) {
      s.systemUp = true;
    }
    let existingDown = 0;
    for (let j = 0; j < m.existingCount; j++) {
      if (s.existingUp[j]) {
        if (rng.next() < rates.failExisting) {
          s.existingUp[j] = 0;
          this.repairExisting[j] = rng.int(rates.repairLow, rates.repairHigh);
        }
      } else if (--this.repairExisting[j] <= 0) {
        s.existingUp[j] = 1;
      }
      if (!s.existingUp[j]) existingDown++;
    }

    const month = Math.floor(((this.week % WEEKS_PER_YEAR) / WEEKS_PER_YEAR) * 12);
    let avail = 0;
    if (m.rain) {
      const r = m.rain;
      avail = this.level + r.catchmentM2 * r.monthlyMmDay[month] * 7 * r.runoff * this.yearFactor;
      s.systemCapL = s.systemUp ? avail / 7 : 0;
    } else {
      s.systemCapL = s.systemUp ? this.yieldL : 0;
    }

    const res = assignWeek(this.world, s, this.result);
    if (m.rain) {
      const drawn = Math.min(res.systemLoadL * 7, avail);
      this.level = Math.min(m.rain.storageL, Math.max(0, avail - drawn));
    }
    updateQueue(s.queue, res.tapLoadL, m.perTapL, QUEUE_SMOOTHING);

    const year = Math.floor(this.week / WEEKS_PER_YEAR);
    this.servedSum += res.served;
    this.hoursSum += res.hoursSaved;
    this.under30Sum += res.under30;
    if (!s.systemUp) this.weeksDown++;
    if (res.saturated) this.satWeeks[year]++;

    const frame: FutureFrame = {
      week: this.week,
      year,
      month,
      systemUp: s.systemUp,
      capacityL: s.systemCapL,
      storageL: m.rain ? this.level : null,
      existingDown,
      result: res,
    };
    this.week++;
    return frame;
  }

  outcome(): FutureOutcome {
    const weeks = Math.max(1, this.week);
    let capacityYear: number | null = null;
    const years = Math.ceil(this.week / WEEKS_PER_YEAR);
    for (let y = 0; y < years; y++) {
      const inYear = Math.min(WEEKS_PER_YEAR, this.week - y * WEEKS_PER_YEAR);
      if (this.satWeeks[y] > inYear / 2) {
        capacityYear = y + 1;
        break;
      }
    }
    return {
      peopleServed: this.servedSum / weeks,
      hoursSavedPerDay: this.hoursSum / weeks,
      peopleUnder30Min: this.under30Sum / weeks,
      weeksDown: this.weeksDown,
      capacityYear,
      clustersAtEnd: this.world.n,
    };
  }
}

/** Run one future to the end. */
export function runFuture(model: SimulationModel, seed: number): FutureOutcome {
  const f = new Future(model, seed);
  while (!f.done) f.step();
  return f.outcome();
}
