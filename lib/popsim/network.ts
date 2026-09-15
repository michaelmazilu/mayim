/**
 * Walking and pipe network from OpenStreetMap lines.
 *
 * Segments are densified to at most DENSIFY_M so that snapping a house or a
 * tap to the nearest vertex is accurate to a few tens of metres even on long,
 * sparsely-noded roads. Distances are shortest paths over the network, so
 * "how far is the tap" is a route, and pipes follow streets like real mains.
 */
import type { LngLat } from "@/lib/types";

export type Scale = { mLon: number; mLat: number };

const M_PER_DEG_LAT = 111_320;

export function scaleAt(lat: number): Scale {
  return { mLat: M_PER_DEG_LAT, mLon: Math.max(1, M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)) };
}

export function metres(s: Scale, lon1: number, lat1: number, lon2: number, lat2: number): number {
  return Math.hypot((lon2 - lon1) * s.mLon, (lat2 - lat1) * s.mLat);
}

export type Graph = {
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  adjStart: Int32Array;
  adjTo: Int32Array;
  adjW: Float64Array;
  scale: Scale;
  cellLon: number;
  cellLat: number;
  grid: Map<string, number[]>;
};

export const DENSIFY_M = 40;
export const SNAP_RADIUS_M = 400;
const CELL_M = 150;
const MERGE = 1e5;

export function buildGraph(lines: LngLat[][], scale: Scale): Graph | null {
  const ids = new Map<string, number>();
  const lons: number[] = [];
  const lats: number[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const w: number[] = [];

  const node = (lon: number, lat: number): number => {
    const k = `${Math.round(lon * MERGE)},${Math.round(lat * MERGE)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = lons.length;
      ids.set(k, id);
      lons.push(lon);
      lats.push(lat);
    }
    return id;
  };
  const link = (a: number, b: number) => {
    if (a === b) return;
    const d = metres(scale, lons[a], lats[a], lons[b], lats[b]);
    from.push(a, b);
    to.push(b, a);
    w.push(d, d);
  };

  for (const line of lines) {
    let prev = -1;
    let pLon = 0;
    let pLat = 0;
    for (const c of line) {
      const lon = c[0];
      const lat = c[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (prev >= 0) {
        const len = metres(scale, pLon, pLat, lon, lat);
        const steps = Math.max(1, Math.ceil(len / DENSIFY_M));
        let last = prev;
        for (let s = 1; s <= steps; s++) {
          const f = s / steps;
          const cur = node(pLon + (lon - pLon) * f, pLat + (lat - pLat) * f);
          link(last, cur);
          last = cur;
        }
        prev = last;
      } else {
        prev = node(lon, lat);
      }
      pLon = lon;
      pLat = lat;
    }
  }

  const n = lons.length;
  if (n < 2) return null;
  const adjStart = new Int32Array(n + 1);
  for (const f of from) adjStart[f + 1]++;
  for (let i = 0; i < n; i++) adjStart[i + 1] += adjStart[i];
  const fill = adjStart.slice(0, n);
  const adjTo = new Int32Array(from.length);
  const adjW = new Float64Array(from.length);
  for (let e = 0; e < from.length; e++) {
    const slot = fill[from[e]]++;
    adjTo[slot] = to[e];
    adjW[slot] = w[e];
  }

  const cellLon = CELL_M / scale.mLon;
  const cellLat = CELL_M / scale.mLat;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(lons[i] / cellLon)},${Math.floor(lats[i] / cellLat)}`;
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  return {
    n,
    lon: Float64Array.from(lons),
    lat: Float64Array.from(lats),
    adjStart,
    adjTo,
    adjW,
    scale,
    cellLon,
    cellLat,
    grid,
  };
}

/** Nearest vertex within maxM, searching the grid ring by ring. */
export function snapPoint(g: Graph, lon: number, lat: number, maxM = SNAP_RADIUS_M): { node: number; offsetM: number } {
  const cx = Math.floor(lon / g.cellLon);
  const cy = Math.floor(lat / g.cellLat);
  const rings = Math.ceil(maxM / CELL_M) + 1;
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r <= rings; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const list = g.grid.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const i of list) {
          const d = metres(g.scale, lon, lat, g.lon[i], g.lat[i]);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    // Anything in a later ring is at least r cells away.
    if (best >= 0 && bestD <= r * CELL_M) break;
  }
  return best >= 0 && bestD <= maxM ? { node: best, offsetM: bestD } : { node: -1, offsetM: Infinity };
}

export function snapMany(
  g: Graph,
  lon: ArrayLike<number>,
  lat: ArrayLike<number>,
  count: number,
  maxM = SNAP_RADIUS_M,
): { node: Int32Array; offsetM: Float64Array } {
  const node = new Int32Array(count);
  const offsetM = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const s = snapPoint(g, lon[i], lat[i], maxM);
    node[i] = s.node;
    offsetM[i] = s.offsetM;
  }
  return { node, offsetM };
}

/** Binary heap on parallel arrays. */
class Heap {
  private d: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.d.length;
  }
  push(dist: number, node: number): void {
    const d = this.d;
    const v = this.v;
    d.push(dist);
    v.push(node);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p] <= d[i]) break;
      [d[p], d[i]] = [d[i], d[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const d = this.d;
    const v = this.v;
    const top: [number, number] = [d[0], v[0]];
    const ld = d.pop() as number;
    const lv = v.pop() as number;
    if (d.length > 0) {
      d[0] = ld;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && d[l] < d[m]) m = l;
        if (r < d.length && d[r] < d[m]) m = r;
        if (m === i) break;
        [d[m], d[i]] = [d[i], d[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

export type Paths = { dist: Float64Array; prev: Int32Array; label: Int32Array };

/**
 * Multi-source Dijkstra. Each start carries its own initial distance (the
 * off-network walk to its vertex) and a label, so the result also says which
 * start is nearest to every vertex. Vertices beyond cutoffM stay at Infinity.
 */
export function dijkstra(g: Graph, starts: { node: number; d: number; label: number }[], cutoffM = Infinity): Paths {
  const dist = new Float64Array(g.n).fill(Infinity);
  const prev = new Int32Array(g.n).fill(-1);
  const label = new Int32Array(g.n).fill(-1);
  const heap = new Heap();
  for (const s of starts) {
    if (s.node < 0) continue;
    const d0 = Number.isFinite(s.d) ? Math.max(0, s.d) : 0;
    if (d0 < dist[s.node]) {
      dist[s.node] = d0;
      label[s.node] = s.label;
      heap.push(d0, s.node);
    }
  }
  while (heap.size > 0) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    if (d > cutoffM) break;
    for (let e = g.adjStart[u]; e < g.adjStart[u + 1]; e++) {
      const v = g.adjTo[e];
      const nd = d + g.adjW[e];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        label[v] = label[u];
        heap.push(nd, v);
      }
    }
  }
  if (Number.isFinite(cutoffM)) for (let i = 0; i < g.n; i++) if (dist[i] > cutoffM) dist[i] = Infinity;
  return { dist, prev, label };
}

/** Vertex path from the search's start to `target`, as coordinates, start first. */
export function pathTo(g: Graph, prev: Int32Array, target: number): number[] {
  const out: number[] = [];
  let cur = target;
  let guard = 0;
  while (cur >= 0 && guard++ < g.n) {
    out.push(cur);
    cur = prev[cur];
  }
  return out.reverse();
}

/** Vertices within radiusM of a point (straight line), via the grid. */
export function verticesWithin(g: Graph, lon: number, lat: number, radiusM: number): number[] {
  const cx = Math.floor(lon / g.cellLon);
  const cy = Math.floor(lat / g.cellLat);
  const r = Math.ceil(radiusM / CELL_M) + 1;
  const out: number[] = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const list = g.grid.get(`${cx + dx},${cy + dy}`);
      if (!list) continue;
      for (const i of list) if (metres(g.scale, lon, lat, g.lon[i], g.lat[i]) <= radiusM) out.push(i);
    }
  }
  return out.sort((a, b) => a - b);
}
