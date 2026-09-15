/**
 * Per-replay constants for the map. Computed once from week zero, so the heat
 * and the dots are scaled against a fixed reference: growth and outages then
 * read as change on the map instead of being normalised away frame by frame.
 */
import type { SimulationReplay } from "@/lib/types";
import { evaluateStatic, K } from "@/lib/popsim/engine";
import type { ReplayStats } from "./types";

const M_PER_DEG = 111_320;
const NO_SOURCE_FALLBACK_MIN = 60;

function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Week-zero round trip without the project, from the engine when it can run. */
function baselineMinutes(replay: SimulationReplay, n: number): number[] {
  try {
    const { result } = evaluateStatic(replay);
    return Array.from(result.baseline.subarray(0, n));
  } catch {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      let best = NO_SOURCE_FALLBACK_MIN;
      for (let k = 0; k < K; k++) {
        const one = replay.baseMin[i * K + k];
        if (one >= 0 && 2 * one < best) best = 2 * one;
      }
      out.push(best);
    }
    return out;
  }
}

export function replayStats(replay: SimulationReplay): ReplayStats {
  const n = Math.max(0, Math.min(replay.n, replay.lon.length, replay.lat.length, replay.people.length));

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const extend = (lon: number, lat: number): void => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  };
  for (let i = 0; i < n; i++) extend(replay.lon[i], replay.lat[i]);
  for (let t = 0; t < replay.tapCount; t++) extend(replay.tapLon[t], replay.tapLat[t]);
  if (!Number.isFinite(west)) {
    west = 0;
    south = 0;
    east = 0;
    north = 0;
  }
  const centerLat = (south + north) / 2;

  const people: number[] = [];
  for (let i = 0; i < n; i++) if (replay.people[i] > 0) people.push(replay.people[i]);
  const peopleRef = Math.max(1, quantile(people, 0.5));

  const base = baselineMinutes(replay, n);
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = replay.people[i] * base[i];
    if (w > 0 && Number.isFinite(w)) weights.push(w);
  }
  const weightRef = Math.max(1, quantile(weights, 0.9));

  // Nearest-neighbour spacing from a strided sample: enough to size the heat
  // kernel, and bounded at a few hundred thousand distance checks.
  const mLon = M_PER_DEG * Math.max(0.05, Math.cos((centerLat * Math.PI) / 180));
  const stride = Math.max(1, Math.floor(n / 300));
  const nearest: number[] = [];
  for (let i = 0; i < n; i += stride) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = (replay.lon[j] - replay.lon[i]) * mLon;
      const dy = (replay.lat[j] - replay.lat[i]) * M_PER_DEG;
      const d = dx * dx + dy * dy;
      if (d > 0 && d < best) best = d;
    }
    if (Number.isFinite(best)) nearest.push(Math.sqrt(best));
  }
  const spacingM = Math.min(400, Math.max(20, nearest.length > 0 ? quantile(nearest, 0.5) : 80));

  return {
    bounds: [
      [west, south],
      [east, north],
    ],
    centerLat,
    peopleRef,
    weightRef,
    spacingM,
  };
}
