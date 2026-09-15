/**
 * Where each household cluster fetches water today.
 *
 * Only points a household actually fills containers at count: wells,
 * boreholes, springs and drinking-water taps. Reservoirs, water towers and
 * treatment works are infrastructure, not collection points. The nearest one
 * is found over the walking network; the next two by straight line, so a
 * household has somewhere to go when its usual point is broken.
 */
import type { OsmPoint } from "@/lib/types";
import { BEHAVIOUR } from "@/lib/config/coefficients";
import { K, SPEED_M_PER_MIN } from "@/lib/popsim/engine";
import type { Clusters } from "@/lib/popsim/demand";
import { dijkstra, snapMany, type Graph, type Scale } from "@/lib/popsim/network";

export const IMPROVED_KINDS = new Set(["water_well", "borehole", "drinking_water", "spring"]);
/** Beyond this nobody walks to a point; the fallback applies instead. */
const MAX_WALK_M = 5000;
const DETOUR = BEHAVIOUR.detourFactor.value;

export type BaselineTable = { idx: Int32Array; oneWay: Float64Array };

export function improvedPoints(points: OsmPoint[]): OsmPoint[] {
  return points.filter((p) => IMPROVED_KINDS.has(p.kind) && Number.isFinite(p.lon) && Number.isFinite(p.lat));
}

export function buildBaseline(
  c: Clusters,
  existing: OsmPoint[],
  scale: Scale,
  graph: Graph | null,
  clusterSnap: { node: Int32Array; offsetM: Float64Array } | null,
): BaselineTable {
  const idx = new Int32Array(c.n * K).fill(-1);
  const oneWay = new Float64Array(c.n * K).fill(-1);
  const P = existing.length;
  if (P === 0) return { idx, oneWay };

  let routed: ReturnType<typeof dijkstra> | null = null;
  if (graph && clusterSnap) {
    const ps = snapMany(graph, existing.map((p) => p.lon), existing.map((p) => p.lat), P);
    const starts = [];
    for (let j = 0; j < P; j++) if (ps.node[j] >= 0) starts.push({ node: ps.node[j], d: ps.offsetM[j], label: j });
    routed = dijkstra(graph, starts, MAX_WALK_M);
  }

  const px = Float64Array.from(existing, (p) => p.lon * scale.mLon);
  const py = Float64Array.from(existing, (p) => p.lat * scale.mLat);
  const bestJ = new Int32Array(K + 1);
  const bestD = new Float64Array(K + 1);
  for (let i = 0; i < c.n; i++) {
    // The K+1 nearest by straight line, in one pass (the routed nearest may be among them).
    bestJ.fill(-1);
    bestD.fill(Infinity);
    const x = c.lon[i] * scale.mLon;
    const y = c.lat[i] * scale.mLat;
    for (let j = 0; j < P; j++) {
      const d = Math.hypot(px[j] - x, py[j] - y);
      if (d >= bestD[K]) continue;
      let k = K;
      while (k > 0 && bestD[k - 1] > d) {
        bestD[k] = bestD[k - 1];
        bestJ[k] = bestJ[k - 1];
        k--;
      }
      bestD[k] = d;
      bestJ[k] = j;
    }

    let slot = 0;
    const node = clusterSnap ? clusterSnap.node[i] : -1;
    if (routed && node >= 0 && Number.isFinite(routed.dist[node]) && routed.label[node] >= 0) {
      const j0 = routed.label[node];
      // Where the map has no path, people still walk across: never longer than the detoured straight line.
      const straight = Math.hypot(px[j0] - c.lon[i] * scale.mLon, py[j0] - c.lat[i] * scale.mLat) * DETOUR;
      const m = Math.min(clusterSnap!.offsetM[i] + routed.dist[node], straight);
      if (m <= MAX_WALK_M) {
        idx[i * K] = j0;
        oneWay[i * K] = m / SPEED_M_PER_MIN;
        slot = 1;
      }
    }
    for (let o = 0; o <= K && slot < K; o++) {
      const j = bestJ[o];
      if (j < 0 || bestD[o] > MAX_WALK_M) break;
      if (slot > 0 && idx[i * K] === j) continue;
      idx[i * K + slot] = j;
      oneWay[i * K + slot] = (bestD[o] * DETOUR) / SPEED_M_PER_MIN;
      slot++;
    }
  }
  return { idx, oneWay };
}

/** Today's round trip per cluster, all points working, capped at the no-source fallback. */
export function baselineRoundTrip(c: Clusters, t: BaselineTable): Float64Array {
  const out = new Float64Array(c.n);
  const cap = BEHAVIOUR.noSourceRoundTripMinutes.value;
  for (let i = 0; i < c.n; i++) {
    let best = cap;
    for (let k = 0; k < K; k++) {
      const m = t.oneWay[i * K + k];
      if (m >= 0 && 2 * m < best) best = 2 * m;
    }
    out[i] = best;
  }
  return out;
}
