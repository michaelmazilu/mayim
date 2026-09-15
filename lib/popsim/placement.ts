/**
 * Where the water system goes, and where its taps go.
 *
 * 1. Each system type is anchored to what it physically needs: a borehole or a
 *    tanker-filled tank beside a road (rig and truck access), a rainwater tank
 *    on a school or clinic roof, a filter at a raw-water source, a
 *    rehabilitation at the existing well it restores.
 * 2. Taps go, one at a time, where they save the most walking for the people
 *    not yet served, each loaded to the Sphere 250-person planning figure, on
 *    the walking network, and at least 180 m apart.
 * 3. Pipes follow the network from the tank to every tap. Shared runs are
 *    counted once, so the priced length is the length of trench dug.
 */
import type { Candidate, ConceptualLayoutData, InfrastructureType, LngLat, OsmData, OsmPoint } from "@/lib/types";
import { BEHAVIOUR } from "@/lib/config/coefficients";
import { SPEED_M_PER_MIN } from "@/lib/popsim/engine";
import type { Clusters } from "@/lib/popsim/demand";
import { dijkstra, metres, pathTo, scaleAt, snapPoint, verticesWithin, type Graph, type Scale } from "@/lib/popsim/network";

export type Anchor = {
  type: InfrastructureType;
  lon: number;
  lat: number;
  label: string;
  /** Index of the existing point this project takes over, or -1. */
  replaces: number;
  key: string;
};

export type RawSource = { lon: number; lat: number; label: string };

export type PlaceCtx = {
  scale: Scale;
  graph: Graph | null;
  clusters: Clusters;
  /** Today's round trip per cluster, minutes. */
  baselineRt: Float64Array;
  /** Improved existing points, indexed as in the baseline table. */
  existing: OsmPoint[];
  rawSources: RawSource[];
  institutions: OsmPoint[];
  /** Surveyed points reported broken: where rehabilitation is aimed when survey data exists. */
  broken?: OsmPoint[];
};

export type Tap = { lon: number; lat: number; node: number };

const BOREHOLE_MIN_GROUNDWATER = 0.35;
const REHAB_RADIUS_M = 600;
const RAIN_RADIUS_M = 800;
const RAW_RADIUS_M = 600;
const ROADSIDE_SEARCH_M = 250;
const ROADSIDE_OFFSET_M = 12;
export const TAP_RADIUS_M = 900;
export const DEMAND_RADIUS_M = 1500;
const TAP_SPACING_M = 180;
const CANDIDATE_GRID_M = 40;
/** Mild preference for taps nearer the tank, so equal gains do not buy longer pipe. */
const PIPE_PENALTY = 0.15;
const DETOUR = BEHAVIOUR.detourFactor.value;

export const MAX_TAPS: Record<InfrastructureType, number> = {
  solar_borehole: 6,
  borehole_rehabilitation: 4,
  rainwater_harvesting: 4,
  filtration_and_storage: 5,
  community_storage_and_taps: 6,
};

const round4 = (v: number) => v.toFixed(4);

/** Raw-water sources for treatment: mapped water features plus river and stream vertices. */
export function rawSourcesFrom(osm: OsmData): RawSource[] {
  const words: Record<string, string> = {
    reservoir: "the reservoir",
    spring: "the spring",
    water_well: "the well",
    borehole: "the borehole",
    drinking_water: "the tap",
    water_works: "the water works",
    water_tower: "the water tower",
  };
  const out: RawSource[] = osm.waterPoints.map((p) => ({
    lon: p.lon,
    lat: p.lat,
    label: p.name ? `${words[p.kind] ?? "the source"} "${p.name}"` : (words[p.kind] ?? "the source"),
  }));
  for (const w of osm.waterways) {
    const label = w.name ? `the ${w.kind} "${w.name}"` : `the ${w.kind}`;
    for (const c of w.coords) out.push({ lon: c[0], lat: c[1], label });
  }
  return out;
}

function nearestOf<T extends { lon: number; lat: number }>(
  s: Scale,
  lon: number,
  lat: number,
  items: T[],
  maxM: number,
  keep: (t: T, i: number) => boolean = () => true,
): { item: T; index: number; d: number } | null {
  let best: { item: T; index: number; d: number } | null = null;
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    if (!keep(t, i)) continue;
    const d = metres(s, lon, lat, t.lon, t.lat);
    if (d <= maxM && (!best || d < best.d)) best = { item: t, index: i, d };
  }
  return best;
}

/** A point a few metres off the nearest road, toward the site: where a rig or tanker can reach it. */
function roadside(ctx: PlaceCtx, lon: number, lat: number): { lon: number; lat: number; onRoad: boolean } {
  if (!ctx.graph) return { lon, lat, onRoad: false };
  const s = snapPoint(ctx.graph, lon, lat, ROADSIDE_SEARCH_M);
  if (s.node < 0) return { lon, lat, onRoad: false };
  const vx = ctx.graph.lon[s.node];
  const vy = ctx.graph.lat[s.node];
  if (s.offsetM <= ROADSIDE_OFFSET_M) return { lon, lat, onRoad: true };
  const f = ROADSIDE_OFFSET_M / s.offsetM;
  return { lon: vx + (lon - vx) * f, lat: vy + (lat - vy) * f, onRoad: true };
}

export function anchorFor(type: InfrastructureType, cand: Candidate, ctx: PlaceCtx): Anchor | null {
  const s = ctx.scale;
  const make = (lon: number, lat: number, label: string, replaces = -1): Anchor => ({
    type,
    lon,
    lat,
    label,
    replaces,
    key: `${type}:${round4(lon)},${round4(lat)}`,
  });

  switch (type) {
    case "solar_borehole": {
      const gw = cand.features.groundwaterEvidenceScore;
      if (!(gw >= BOREHOLE_MIN_GROUNDWATER)) return null;
      const p = roadside(ctx, cand.lon, cand.lat);
      return make(
        p.lon,
        p.lat,
        `${p.onRoad ? "Drilled beside the road for rig access" : "Drilled at the site"}; groundwater evidence ${gw.toFixed(2)}`,
      );
    }
    case "community_storage_and_taps": {
      const p = roadside(ctx, cand.lon, cand.lat);
      if (!p.onRoad) return null;
      return make(p.lon, p.lat, "Tanker-filled storage beside the road");
    }
    case "borehole_rehabilitation": {
      const isWell = (p: OsmPoint) => p.kind === "water_well" || p.kind === "borehole";
      const broken = ctx.broken ?? [];
      const restore = nearestOf(s, cand.lon, cand.lat, broken, REHAB_RADIUS_M, isWell);
      if (restore) {
        const what = restore.item.kind === "borehole" ? "borehole" : "well";
        return make(restore.item.lon, restore.item.lat, `Restores a broken ${what}${restore.item.name ? ` (${restore.item.name})` : ""}`);
      }
      // With survey data, rehabilitation is aimed only at points reported broken.
      if (broken.length > 0) return null;
      const hit = nearestOf(s, cand.lon, cand.lat, ctx.existing, REHAB_RADIUS_M, (p) =>
        p.kind === "water_well" || p.kind === "borehole",
      );
      if (!hit) return null;
      const what = hit.item.kind === "borehole" ? "borehole" : "well";
      const name = hit.item.name ? ` "${hit.item.name}"` : "";
      return make(hit.item.lon, hit.item.lat, `Rehabilitates the existing ${what}${name}`, hit.index);
    }
    case "rainwater_harvesting": {
      const hit = nearestOf(s, cand.lon, cand.lat, ctx.institutions, RAIN_RADIUS_M);
      if (!hit) return null;
      const p = hit.item;
      const what = p.name ?? (/school/.test(p.kind) ? "a school" : "a clinic");
      return make(p.lon, p.lat, `Harvests the roof of ${what}`);
    }
    case "filtration_and_storage": {
      const hit = nearestOf(s, cand.lon, cand.lat, ctx.rawSources, RAW_RADIUS_M);
      if (!hit) return null;
      return make(hit.item.lon, hit.item.lat, `Treats water drawn from ${hit.item.label}`);
    }
  }
}

/** Greedy, capacity-aware tap siting. Deterministic: ties go to the lower candidate index. */
export function placeTaps(ctx: PlaceCtx, anchor: Anchor, K: number, capacityPeople: number): Tap[] {
  const s = ctx.scale;
  const c = ctx.clusters;
  const ax = anchor.lon * s.mLon;
  const ay = anchor.lat * s.mLat;

  const qx: number[] = [];
  const qy: number[] = [];
  const remain: number[] = [];
  const base: number[] = [];
  for (let i = 0; i < c.n; i++) {
    const x = c.lon[i] * s.mLon;
    const y = c.lat[i] * s.mLat;
    if (Math.hypot(x - ax, y - ay) > DEMAND_RADIUS_M) continue;
    qx.push(x);
    qy.push(y);
    remain.push(c.people[i]);
    base.push(ctx.baselineRt[i]);
  }
  const m = qx.length;

  const cands: Tap[] = [];
  if (ctx.graph) {
    const seen = new Set<string>();
    for (const v of verticesWithin(ctx.graph, anchor.lon, anchor.lat, TAP_RADIUS_M)) {
      const lon = ctx.graph.lon[v];
      const lat = ctx.graph.lat[v];
      const k = `${Math.floor((lon * s.mLon) / CANDIDATE_GRID_M)},${Math.floor((lat * s.mLat) / CANDIDATE_GRID_M)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      cands.push({ lon, lat, node: v });
    }
  }
  if (cands.length === 0) {
    for (let dx = -TAP_RADIUS_M; dx <= TAP_RADIUS_M; dx += 60) {
      for (let dy = -TAP_RADIUS_M; dy <= TAP_RADIUS_M; dy += 60) {
        if (Math.hypot(dx, dy) <= TAP_RADIUS_M) cands.push({ lon: anchor.lon + dx / s.mLon, lat: anchor.lat + dy / s.mLat, node: -1 });
      }
    }
  }
  const cx = cands.map((t) => t.lon * s.mLon);
  const cy = cands.map((t) => t.lat * s.mLat);
  const perRt = (2 * DETOUR) / SPEED_M_PER_MIN;
  const perTap = BEHAVIOUR.peoplePerTap.value;

  const taps: Tap[] = [];
  let systemPeople = capacityPeople;

  const consume = (tx: number, ty: number) => {
    const cap = Math.min(perTap, systemPeople);
    const hits: { q: number; rt: number }[] = [];
    for (let q = 0; q < m; q++) {
      if (remain[q] <= 0) continue;
      const rt = Math.hypot(qx[q] - tx, qy[q] - ty) * perRt;
      if (rt < base[q]) hits.push({ q, rt });
    }
    hits.sort((a, b) => a.rt - b.rt || a.q - b.q);
    let left = cap;
    for (const h of hits) {
      if (left <= 0) break;
      const take = Math.min(left, remain[h.q]);
      remain[h.q] -= take;
      left -= take;
    }
    systemPeople -= cap - left;
  };

  if (anchor.type === "borehole_rehabilitation") {
    const node = ctx.graph ? snapPoint(ctx.graph, anchor.lon, anchor.lat, 60).node : -1;
    taps.push({ lon: anchor.lon, lat: anchor.lat, node });
    consume(ax, ay);
  }

  while (taps.length < K && systemPeople > 1) {
    let best = -1;
    let bestGain = 0;
    for (let k = 0; k < cands.length; k++) {
      let tooClose = false;
      for (const t of taps) {
        if (Math.hypot(t.lon * s.mLon - cx[k], t.lat * s.mLat - cy[k]) < TAP_SPACING_M) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      let gain = 0;
      for (let q = 0; q < m; q++) {
        const r = remain[q];
        if (r <= 0) continue;
        const save = base[q] - Math.hypot(qx[q] - cx[k], qy[q] - cy[k]) * perRt;
        if (save > 0) gain += r * save;
      }
      gain *= 1 - (PIPE_PENALTY * Math.hypot(cx[k] - ax, cy[k] - ay)) / TAP_RADIUS_M;
      if (gain > bestGain) {
        bestGain = gain;
        best = k;
      }
    }
    if (best < 0) break;
    taps.push(cands[best]);
    consume(cx[best], cy[best]);
  }
  return taps;
}

/** Drop vertices that do not change direction, so a densified straight run is two points. */
function simplify(line: LngLat[]): LngLat[] {
  if (line.length <= 2) return line;
  const out: LngLat[] = [line[0]];
  for (let i = 1; i < line.length - 1; i++) {
    const [ax, ay] = out[out.length - 1];
    const [bx, by] = line[i];
    const [cx, cy] = line[i + 1];
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(cx - ax, cy - ay) || 1;
    if (Math.abs(cross) / len > 2e-6) out.push(line[i]);
  }
  out.push(line[line.length - 1]);
  return out;
}

export function routePipes(
  ctx: PlaceCtx,
  anchor: Anchor,
  taps: Tap[],
): { lines: LngLat[][]; lengthM: number; hub: LngLat } {
  const s = ctx.scale;
  const straight = () => ({
    lines: taps.map((t) => [[anchor.lon, anchor.lat], [t.lon, t.lat]] as LngLat[]),
    lengthM: Math.round(taps.reduce((sum, t) => sum + metres(s, anchor.lon, anchor.lat, t.lon, t.lat), 0)),
    hub: [anchor.lon, anchor.lat] as LngLat,
  });
  const g = ctx.graph;
  if (!g) return straight();
  const start = snapPoint(g, anchor.lon, anchor.lat, 400);
  if (start.node < 0) return straight();

  const tree = dijkstra(g, [{ node: start.node, d: 0, label: 0 }], 5000);
  const hub: LngLat = [g.lon[start.node], g.lat[start.node]];
  const edges = new Set<string>();
  let length = start.offsetM;
  const lines: LngLat[][] = [];
  for (const t of taps) {
    if (t.node < 0 || !Number.isFinite(tree.dist[t.node])) {
      lines.push([hub, [t.lon, t.lat]]);
      length += metres(s, hub[0], hub[1], t.lon, t.lat);
      continue;
    }
    const path = pathTo(g, tree.prev, t.node);
    const coords: LngLat[] = path.map((v) => [g.lon[v], g.lat[v]]);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (edges.has(key)) continue;
      edges.add(key);
      length += metres(s, g.lon[a], g.lat[a], g.lon[b], g.lat[b]);
    }
    lines.push(simplify(coords.length >= 2 ? coords : [hub, [t.lon, t.lat]]));
  }
  return { lines, lengthM: Math.round(length), hub };
}

export function buildLayout(
  anchor: Anchor,
  taps: Tap[],
  routed: { lines: LngLat[][]; lengthM: number; hub: LngLat },
): ConceptualLayoutData {
  const s = scaleAt(anchor.lat);
  const dx = (routed.hub[0] - anchor.lon) * s.mLon;
  const dy = (routed.hub[1] - anchor.lat) * s.mLat;
  const L = Math.hypot(dx, dy);
  const ux = L > 1 ? dx / L : 0;
  const uy = L > 1 ? dy / L : 1;
  const at = (lon: number, lat: number, east: number, north: number): LngLat => [
    +(lon + east / s.mLon).toFixed(6),
    +(lat + north / s.mLat).toFixed(6),
  ];
  const source: LngLat = [+anchor.lon.toFixed(6), +anchor.lat.toFixed(6)];
  const tank = at(anchor.lon, anchor.lat, ux * 30, uy * 30);
  const treatment = at(tank[0], tank[1], -uy * 18, ux * 18);

  let reach = 0;
  for (const t of taps) reach = Math.max(reach, metres(s, anchor.lon, anchor.lat, t.lon, t.lat));
  const radius = Math.max(400, reach + 250);
  const ring: LngLat[] = [];
  for (let i = 0; i <= 64; i++) {
    const th = (i / 64) * 2 * Math.PI;
    ring.push(at(anchor.lon, anchor.lat, radius * Math.cos(th), radius * Math.sin(th)));
  }
  const round = (line: LngLat[]) => line.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)] as LngLat);
  return {
    source,
    tank,
    treatment,
    taps: taps.map((t) => [+t.lon.toFixed(6), +t.lat.toFixed(6)] as LngLat),
    pipes: [round([source, tank, treatment, routed.hub]), ...routed.lines.map(round)],
    serviceRadiusRing: ring,
    pipelineLengthM: routed.lengthM + 48,
    tapStandCount: taps.length,
  };
}
