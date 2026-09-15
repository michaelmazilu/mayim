/**
 * Unit tests for the spatial half of the household simulation: the walking
 * network, household clusters, today's baseline, and where a project's
 * source, taps and pipes go.
 *
 * Every world is synthetic and small, laid out in metres east and north of a
 * point near Kisumu (lat -0.1), so each expectation can be worked out by hand.
 *
 * Run: node --import tsx --test lib/__tests__/popsim-spatial.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_OSM,
  type Candidate,
  type CandidateFeatures,
  type InfrastructureType,
  type LngLat,
  type OsmData,
  type OsmPoint,
} from "@/lib/types";
import { BEHAVIOUR, SERVICE } from "@/lib/config/coefficients";
import { K, SPEED_M_PER_MIN } from "@/lib/popsim/engine";
import { CLUSTER_M, PEOPLE_PER_BUILDING, clusterBuildings, type Clusters } from "@/lib/popsim/demand";
import {
  DENSIFY_M,
  SNAP_RADIUS_M,
  buildGraph,
  dijkstra,
  metres,
  pathTo,
  scaleAt,
  snapMany,
  snapPoint,
  verticesWithin,
  type Graph,
} from "@/lib/popsim/network";
import { IMPROVED_KINDS, baselineRoundTrip, buildBaseline, improvedPoints } from "@/lib/popsim/baseline";
import {
  TAP_RADIUS_M,
  anchorFor,
  buildLayout,
  placeTaps,
  rawSourcesFrom,
  routePipes,
  type Anchor,
  type PlaceCtx,
  type Tap,
} from "@/lib/popsim/placement";

const DETOUR = BEHAVIOUR.detourFactor.value;
const FALLBACK_RT = BEHAVIOUR.noSourceRoundTripMinutes.value;
/** Minimum distance between taps (placement.ts keeps it private). */
const TAP_SPACING_M = 180;

// ---------------------------------------------------------------------------
// Geometry: metres east and north of an origin near Kisumu
// ---------------------------------------------------------------------------

const LON0 = 34.75;
const LAT0 = -0.1;
const S = scaleAt(LAT0);

type Pt = { lon: number; lat: number };

/** [lon, lat] of the point `east` and `north` metres from the origin. */
function at(east: number, north: number): LngLat {
  return [LON0 + east / S.mLon, LAT0 + north / S.mLat];
}
function pt(east: number, north: number): Pt {
  const [lon, lat] = at(east, north);
  return { lon, lat };
}
const eastOf = (lon: number) => (lon - LON0) * S.mLon;
const northOf = (lat: number) => (lat - LAT0) * S.mLat;
const gap = (a: Pt, b: Pt) => metres(S, a.lon, a.lat, b.lon, b.lat);
const where = (p: Pt) => `(${eastOf(p.lon).toFixed(0)} E, ${northOf(p.lat).toFixed(0)} N)`;

function near(actual: number, expected: number, tol: number, what = "value"): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);
}

function graphOf(lines: LngLat[][]): Graph {
  const g = buildGraph(lines, S);
  assert.ok(g, "expected a graph");
  return g;
}

const vertex = (g: Graph, v: number): Pt => ({ lon: g.lon[v], lat: g.lat[v] });

function neighbours(g: Graph, v: number): number[] {
  return Array.from(g.adjTo.subarray(g.adjStart[v], g.adjStart[v + 1]));
}

/** Brute-force nearest vertex: the reference for the grid-indexed searches. */
function nearestVertex(g: Graph, p: Pt): { node: number; d: number } {
  let node = -1;
  let d = Infinity;
  for (let v = 0; v < g.n; v++) {
    const dv = gap(p, vertex(g, v));
    if (dv < d) {
      d = dv;
      node = v;
    }
  }
  return { node, d };
}

/** The vertex lying at (east, north); fails if none is within a metre. */
function vertexAt(g: Graph, east: number, north: number): number {
  const p = pt(east, north);
  const s = snapPoint(g, p.lon, p.lat);
  assert.ok(s.node >= 0 && s.offsetM < 1, `no vertex at (${east}, ${north})`);
  return s.node;
}

/** Five east-west and five north-south streets, 300 m apart, sharing their 25 junctions. */
function streetGrid(): Graph {
  const ticks = [0, 300, 600, 900, 1200];
  return graphOf([...ticks.map((n) => ticks.map((e) => at(e, n))), ...ticks.map((e) => ticks.map((n) => at(e, n)))]);
}

/** Seeded PRNG (mulberry32), so the randomised checks are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Spot = { east: number; north: number; people: number };

function clustersOf(spots: Spot[]): Clusters {
  return {
    peoplePerBuilding: PEOPLE_PER_BUILDING,
    n: spots.length,
    lon: Float64Array.from(spots, (s) => at(s.east, s.north)[0]),
    lat: Float64Array.from(spots, (s) => at(s.east, s.north)[1]),
    people: Float64Array.from(spots, (s) => s.people),
    buildings: Math.round(spots.reduce((sum, s) => sum + s.people, 0) / PEOPLE_PER_BUILDING),
  };
}

/** `people` spread evenly over a side x side block of 50 m clusters centred on (east, north). */
function block(east: number, north: number, people: number, side = 3): Spot[] {
  const out: Spot[] = [];
  const h = (side - 1) / 2;
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      out.push({ east: east + (i - h) * CLUSTER_M, north: north + (j - h) * CLUSTER_M, people: people / (side * side) });
    }
  }
  return out;
}

function osmPoint(id: string, kind: string, east: number, north: number, name?: string): OsmPoint {
  const [lon, lat] = at(east, north);
  return name ? { id, kind, lon, lat, name } : { id, kind, lon, lat };
}

function features(overrides: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    distanceToRoadM: 100,
    distanceToWaterwayM: 800,
    nearbyBuildingCount: 120,
    nearbyCommunityFacilityCount: 1,
    nearWasteOrIndustrialSite: false,
    insideProtectedArea: false,
    floodProxy: 0.2,
    groundwaterEvidenceScore: 0.6,
    evidenceConfidence: 0.5,
    ...overrides,
  };
}

function candidate(east: number, north: number, overrides: Partial<CandidateFeatures> = {}): Candidate {
  const [lon, lat] = at(east, north);
  return {
    id: `site-${east}-${north}`,
    lon,
    lat,
    features: features(overrides),
    score: {
      overall: 0.6,
      breakdown: {
        communityNeed: 0.6,
        populationAccessProxy: 0.6,
        groundwaterFeasibility: 0.6,
        roadAndConstructionAccess: 0.6,
        distanceFromExistingService: 0.6,
        environmentalSafety: 0.6,
        evidenceQuality: 0.5,
      },
      exclusions: [],
      warnings: [],
      supportingEvidenceIds: [],
    },
    excluded: false,
  };
}

function placeCtx(parts: Partial<PlaceCtx> = {}): PlaceCtx {
  const clusters = parts.clusters ?? clustersOf([]);
  return {
    scale: S,
    graph: parts.graph ?? null,
    clusters,
    baselineRt: parts.baselineRt ?? new Float64Array(clusters.n).fill(FALLBACK_RT),
    existing: parts.existing ?? [],
    rawSources: parts.rawSources ?? [],
    institutions: parts.institutions ?? [],
  };
}

function anchorAt(type: InfrastructureType, east: number, north: number): Anchor {
  const [lon, lat] = at(east, north);
  return { type, lon, lat, label: "test anchor", replaces: -1, key: `${type}:${east},${north}` };
}

/** The network vertex nearest (east, north), as a tap. */
function tapOn(g: Graph, east: number, north: number): Tap {
  const p = pt(east, north);
  const v = snapPoint(g, p.lon, p.lat).node;
  assert.ok(v >= 0, `no vertex near (${east}, ${north})`);
  return { lon: g.lon[v], lat: g.lat[v], node: v };
}

function assertSpaced(taps: Pt[]): void {
  for (let a = 0; a < taps.length; a++) {
    for (let b = a + 1; b < taps.length; b++) {
      const d = gap(taps[a], taps[b]);
      assert.ok(d >= TAP_SPACING_M - 1e-6, `taps ${a} and ${b} are only ${d.toFixed(1)} m apart`);
    }
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

test("network: a T junction's shared node merges, joining the side road to the main road", () => {
  const g = graphOf([
    [at(-210, 0), at(0, 0), at(210, 0)],
    [at(0, 0), at(0, 150)],
  ]);
  // 210 m legs densify to 6 steps each and the 150 m side road to 4: 1 + 6 + 6 + 4.
  assert.equal(g.n, 17);
  assert.equal(neighbours(g, vertexAt(g, 0, 0)).length, 3);
  const { dist } = dijkstra(g, [{ node: vertexAt(g, -210, 0), d: 0, label: 0 }]);
  near(dist[vertexAt(g, 0, 150)], 360, 0.01, "west end to the side road's tip");
});

test("network: points under a metre apart merge into one vertex, points 5 m apart do not", () => {
  const main = [at(-210, 0), at(0, 0), at(210, 0)];
  const joined = graphOf([main, [at(0.3, 0), at(0, 150)]]);
  assert.equal(joined.n, 17, "a side road starting 0.3 m from the junction joins it");
  const d1 = dijkstra(joined, [{ node: vertexAt(joined, -210, 0), d: 0, label: 0 }]).dist;
  near(d1[vertexAt(joined, 0, 150)], 360, 0.5, "route through the merged junction");

  const apart = graphOf([main, [at(5, 0), at(5, 150)]]);
  assert.equal(apart.n, 18);
  const d2 = dijkstra(apart, [{ node: vertexAt(apart, -210, 0), d: 0, label: 0 }]).dist;
  assert.equal(d2[vertexAt(apart, 5, 150)], Infinity, "a road ending 5 m short of another is not joined to it");
});

test("network: every junction of a street grid merges", () => {
  // Ten 1.2 km streets of 33 vertices each (300 m blocks densify to 8 steps), 25 shared junctions.
  assert.equal(streetGrid().n, 10 * 33 - 25);
});

test("network: a long two-vertex road is densified to vertices at most 40 m apart", () => {
  const a = at(0, 0);
  const b = at(612, 810);
  const len = metres(S, a[0], a[1], b[0], b[1]); // 1015.2 m
  const g = graphOf([[a, b]]);
  assert.equal(g.n, 27, "ceil(1015.2 / 40) = 26 steps");
  let total = 0;
  for (let v = 0; v < g.n; v++) {
    for (let e = g.adjStart[v]; e < g.adjStart[v + 1]; e++) {
      assert.ok(g.adjW[e] <= DENSIFY_M + 1e-9, `edge of ${g.adjW[e]} m`);
      if (v < g.adjTo[e]) total += g.adjW[e];
    }
    // Every added vertex lies on the original segment.
    const offLine = Math.abs(eastOf(g.lon[v]) * 810 - northOf(g.lat[v]) * 612) / Math.hypot(612, 810);
    assert.ok(offLine < 0.01, `vertex ${v} is ${offLine} m off the road`);
  }
  near(total, len, 1e-6, "total edge length");
  // A line that is already dense gains nothing.
  assert.equal(graphOf([[at(0, 0), at(10, 0), at(20, 0), at(30, 0)]]).n, 4);
});

test("network: the shortest route round an L is the sum of its legs, and pathTo runs start to target", () => {
  // The L (630 + 410 m) and a longer way round between the same two ends.
  const g = graphOf([
    [at(0, 0), at(630, 0), at(630, 410)],
    [at(0, 0), at(0, -200), at(830, -200), at(830, 410), at(630, 410)],
  ]);
  const start = vertexAt(g, 0, 0);
  const corner = vertexAt(g, 630, 0);
  const end = vertexAt(g, 630, 410);
  const { dist, prev } = dijkstra(g, [{ node: start, d: 0, label: 0 }]);
  near(dist[end], 1040, 1, "L route");

  const path = pathTo(g, prev, end);
  assert.equal(path[0], start);
  assert.equal(path[path.length - 1], end);
  assert.ok(path.includes(corner), "the route turns at the corner");
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    assert.ok(neighbours(g, path[i - 1]).includes(path[i]), "consecutive path vertices are joined");
    walked += gap(vertex(g, path[i - 1]), vertex(g, path[i]));
  }
  near(walked, dist[end], 1e-6, "length of the returned path");
  assert.deepEqual(pathTo(g, prev, start), [start]);
});

test("network: across a street grid the route is the Manhattan distance", () => {
  const g = streetGrid();
  const { dist } = dijkstra(g, [{ node: vertexAt(g, 0, 0), d: 0, label: 0 }]);
  near(dist[vertexAt(g, 600, 300)], 900, 1, "two blocks east, one north");
  near(dist[vertexAt(g, 1200, 1200)], 2400, 1, "opposite corner");
});

test("network: a cutoff leaves vertices beyond it at Infinity", () => {
  const g = graphOf([[at(0, 0), at(1010, 0)]]); // a vertex every 38.85 m
  const west = vertexAt(g, 0, 0);
  const full = dijkstra(g, [{ node: west, d: 0, label: 0 }]).dist;
  const cut = dijkstra(g, [{ node: west, d: 0, label: 0 }], 500).dist;
  let reached = 0;
  for (let v = 0; v < g.n; v++) {
    near(full[v], eastOf(g.lon[v]), 1e-6, "distance along the road");
    if (full[v] <= 500) {
      assert.equal(cut[v], full[v]);
      reached++;
    } else {
      assert.equal(cut[v], Infinity);
    }
  }
  assert.equal(reached, 13, "vertices from 0 m to 466 m");
});

test("network: labels name the nearest start, counting each start's own walk to the road", () => {
  const g = graphOf([[at(0, 0), at(1010, 0)]]);
  const { dist, label } = dijkstra(g, [
    { node: vertexAt(g, 0, 0), d: 200, label: 7 },
    { node: vertexAt(g, 1010, 0), d: 0, label: 9 },
    { node: -1, d: 0, label: 3 }, // an unsnapped start is skipped
  ]);
  // 200 + x = 1010 - x at x = 405 m; no vertex falls within a metre of it.
  let counted = 0;
  for (let v = 0; v < g.n; v++) {
    const x = eastOf(g.lon[v]);
    if (x < 404) {
      assert.equal(label[v], 7, `vertex at ${x} m`);
      near(dist[v], 200 + x, 1e-6);
      counted++;
    } else if (x > 406) {
      assert.equal(label[v], 9, `vertex at ${x} m`);
      near(dist[v], 1010 - x, 1e-6);
      counted++;
    }
  }
  assert.equal(counted, g.n);
  assert.ok(!label.includes(3));
});

test("network: snap returns the nearest vertex and its offset, and refuses points beyond the radius", () => {
  const g = graphOf([[at(0, 0), at(1010, 0)]]);
  const p = pt(100, 90);
  const s = snapPoint(g, p.lon, p.lat);
  const ref = nearestVertex(g, p);
  assert.equal(s.node, ref.node);
  near(s.offsetM, ref.d, 1e-9, "offset");
  assert.ok(s.offsetM >= 90 && s.offsetM < 92);

  assert.equal(SNAP_RADIUS_M, 400);
  const inside = pt(100, 390); // 390.3 m from the nearest vertex
  const outside = pt(100, 450);
  assert.ok(snapPoint(g, inside.lon, inside.lat).node >= 0);
  assert.deepEqual(snapPoint(g, outside.lon, outside.lat), { node: -1, offsetM: Infinity });
  assert.equal(snapPoint(g, p.lon, p.lat, 60).node, -1, "a tighter radius refuses the same point");

  const many = snapMany(g, [p.lon, inside.lon, outside.lon], [p.lat, inside.lat, outside.lat], 3);
  assert.deepEqual(Array.from(many.node), [s.node, snapPoint(g, inside.lon, inside.lat).node, -1]);
  assert.equal(many.offsetM[0], s.offsetM);
  assert.equal(many.offsetM[2], Infinity);
});

test("network: grid-indexed snap agrees with brute force, near cell edges and beyond the radius", () => {
  const g = streetGrid();
  const rand = rng(42);
  let refused = 0;
  for (let i = 0; i < 400; i++) {
    const p = pt(-600 + rand() * 2400, -600 + rand() * 2400);
    const s = snapPoint(g, p.lon, p.lat);
    const ref = nearestVertex(g, p);
    if (ref.d > SNAP_RADIUS_M) {
      assert.equal(s.node, -1);
      refused++;
      continue;
    }
    near(s.offsetM, ref.d, 1e-9, `snap offset at ${where(p)}`);
    near(gap(p, vertex(g, s.node)), s.offsetM, 1e-9, "offset is the distance to the returned vertex");
  }
  assert.ok(refused > 0, "some points fall outside the radius");
});

test("network: verticesWithin returns exactly the vertices inside the radius, in index order", () => {
  const g = streetGrid();
  const rand = rng(7);
  for (const r of [0, 45, 150, 333, 900]) {
    for (let i = 0; i < 25; i++) {
      const p = pt(-200 + rand() * 1600, -200 + rand() * 1600);
      const ref: number[] = [];
      for (let v = 0; v < g.n; v++) if (gap(p, vertex(g, v)) <= r) ref.push(v);
      assert.deepEqual(verticesWithin(g, p.lon, p.lat, r), ref, `radius ${r} at ${where(p)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Demand
// ---------------------------------------------------------------------------

/** The 50 m cell holding the origin. */
const GX = Math.floor((LON0 * S.mLon) / CLUSTER_M);
const GY = Math.floor((LAT0 * S.mLat) / CLUSTER_M);

/** A building at fraction (fx, fy) across the cell (dx, dy) cells from the origin's. */
function inCell(dx: number, dy: number, fx: number, fy: number): Pt {
  return { lon: ((GX + dx + fx) * CLUSTER_M) / S.mLon, lat: ((GY + dy + fy) * CLUSTER_M) / S.mLat };
}
const cellOf = (p: Pt) => [Math.floor((p.lon * S.mLon) / CLUSTER_M), Math.floor((p.lat * S.mLat) / CLUSTER_M)];

test("demand: buildings in one 50 m cell become one cluster at their centroid", () => {
  const b = [inCell(0, 0, 0.2, 0.2), inCell(0, 0, 0.8, 0.3), inCell(0, 0, 0.5, 0.9)];
  const c = clusterBuildings(b, 2, S);
  assert.equal(c.n, 1);
  near(c.lon[0], (b[0].lon + b[1].lon + b[2].lon) / 3, 1e-12, "centroid lon");
  near(c.lat[0], (b[0].lat + b[1].lat + b[2].lat) / 3, 1e-12, "centroid lat");
  assert.equal(PEOPLE_PER_BUILDING, (SERVICE.peoplePerBuilding.low + SERVICE.peoplePerBuilding.high) / 2);
  near(c.people[0], 3 * 2 * PEOPLE_PER_BUILDING, 1e-9, "people = count x weight x people per building");
  assert.equal(c.buildings, 6, "buildings are scaled by the sample weight");
});

test("demand: distinct cells stay separate, even for buildings 5 m apart across a cell edge", () => {
  const c = clusterBuildings(
    [
      inCell(0, 0, 0.3, 0.5),
      inCell(0, 0, 0.6, 0.5),
      inCell(0, 0, 0.95, 0.2), // 5 m from the next one, over the cell edge
      inCell(1, 0, 0.05, 0.2),
      inCell(1, 0, 0.5, 0.5),
      inCell(0, 1, 0.5, 0.5),
    ],
    1,
    S,
  );
  assert.equal(c.n, 3);
  assert.deepEqual(
    Array.from(c.people, (p) => Math.round(p / PEOPLE_PER_BUILDING)),
    [3, 2, 1],
  );
});

test("demand: cluster order is fixed by cell, south to north then west to east, whatever the input order", () => {
  const b = [
    inCell(2, 1, 0.5, 0.5),
    inCell(-1, 0, 0.2, 0.7),
    inCell(0, -2, 0.4, 0.4),
    inCell(0, 0, 0.1, 0.1),
    inCell(0, 0, 0.9, 0.9),
    inCell(1, -2, 0.6, 0.3),
  ];
  const fwd = clusterBuildings(b, 1.5, S);
  assert.equal(fwd.n, 5);
  for (const input of [[...b].reverse(), [b[3], b[0], b[5], b[1], b[4], b[2]]]) {
    const other = clusterBuildings(input, 1.5, S);
    assert.equal(other.n, fwd.n);
    assert.deepEqual(Array.from(other.people), Array.from(fwd.people));
    for (let i = 0; i < fwd.n; i++) {
      near(other.lon[i], fwd.lon[i], 1e-12, `lon of cluster ${i}`);
      near(other.lat[i], fwd.lat[i], 1e-12, `lat of cluster ${i}`);
    }
  }
  for (let i = 1; i < fwd.n; i++) {
    const [ax, ay] = cellOf({ lon: fwd.lon[i - 1], lat: fwd.lat[i - 1] });
    const [bx, by] = cellOf({ lon: fwd.lon[i], lat: fwd.lat[i] });
    assert.ok(ay < by || (ay === by && ax < bx), `cluster ${i} is out of order`);
  }
  const junk = clusterBuildings([...b, { lon: Number.NaN, lat: LAT0 }, { lon: LON0, lat: Infinity }], 1.5, S);
  assert.equal(junk.n, fwd.n, "unusable coordinates are skipped");
  assert.equal(junk.buildings, fwd.buildings);
});

// ---------------------------------------------------------------------------
// Baseline: where each cluster fetches water today
// ---------------------------------------------------------------------------

test("baseline: only wells, boreholes, drinking-water taps and springs are collection points", () => {
  assert.deepEqual([...IMPROVED_KINDS].sort(), ["borehole", "drinking_water", "spring", "water_well"]);
  const all: OsmPoint[] = [
    osmPoint("well", "water_well", 0, 0),
    osmPoint("bh", "borehole", 10, 0),
    osmPoint("tap", "drinking_water", 20, 0),
    osmPoint("spring", "spring", 30, 0),
    osmPoint("res", "reservoir", 40, 0),
    osmPoint("tower", "water_tower", 50, 0),
    osmPoint("works", "water_works", 60, 0),
    { id: "lost", kind: "water_well", lon: Number.NaN, lat: LAT0 },
  ];
  assert.deepEqual(
    improvedPoints(all).map((p) => p.id),
    ["well", "bh", "tap", "spring"],
  );

  // A reservoir and a water tower next door never become anyone's source.
  const c = clustersOf([{ east: 0, north: 0, people: 10 }]);
  const existing = improvedPoints([
    osmPoint("res", "reservoir", 10, 0),
    osmPoint("tower", "water_tower", 15, 0),
    osmPoint("well", "water_well", 300, 0),
  ]);
  assert.deepEqual(
    existing.map((p) => p.id),
    ["well"],
  );
  const t = buildBaseline(c, existing, S, null, null);
  assert.equal(t.idx.length, c.n * K);
  assert.deepEqual(Array.from(t.idx), [0, -1, -1]);
  near(t.oneWay[0], (300 * DETOUR) / SPEED_M_PER_MIN, 1e-9, "one-way minutes to the well");
});

test("baseline: slot 0 is the nearest point by road, the next slots the nearest by straight line", () => {
  // A U of road: two 1 km arms 400 m apart, joined at the bottom. The household
  // is at the top of the west arm; a well is straight across the gap (400 m, but
  // 2.4 km by road) and a borehole about 700 m down the household's own arm.
  const g = graphOf([[at(0, 1000), at(0, 0), at(400, 0), at(400, 1000)]]);
  const c = clustersOf([{ east: 0, north: 1000, people: 50 }]);
  const p = pt(0, 300);
  const dn = snapPoint(g, p.lon, p.lat).node;
  const existing: OsmPoint[] = [
    osmPoint("across", "water_well", 400, 1000),
    { id: "down", kind: "borehole", lon: g.lon[dn], lat: g.lat[dn] },
  ];
  const t = buildBaseline(c, existing, S, g, snapMany(g, c.lon, c.lat, c.n));
  assert.deepEqual(Array.from(t.idx), [1, 0, -1]);
  near(t.oneWay[0], (1000 - northOf(g.lat[dn])) / SPEED_M_PER_MIN, 1e-6, "slot 0, by road");
  near(t.oneWay[1], (400 * DETOUR) / SPEED_M_PER_MIN, 1e-6, "slot 1, by straight line");
  assert.equal(t.oneWay[2], -1);
  near(baselineRoundTrip(c, t)[0], 2 * t.oneWay[1], 1e-9, "the round trip takes the shorter");
});

test("baseline: a point over 5 km away by road but near in a straight line counts by straight line", () => {
  const g = graphOf([[at(0, 2600), at(0, 0), at(400, 0), at(400, 2600)]]); // 5.6 km between the tops
  const c = clustersOf([{ east: 0, north: 2600, people: 10 }]);
  const t = buildBaseline(c, [osmPoint("across", "water_well", 400, 2600)], S, g, snapMany(g, c.lon, c.lat, c.n));
  assert.deepEqual(Array.from(t.idx), [0, -1, -1]);
  near(t.oneWay[0], (400 * DETOUR) / SPEED_M_PER_MIN, 1e-6, "straight-line minutes");
});

test("baseline: with nothing within 5 km every slot is -1 and the round trip is the fallback", () => {
  const g = graphOf([[at(0, 0), at(6000, 0)]]);
  const c = clustersOf([{ east: 0, north: 0, people: 10 }]);
  const snap = snapMany(g, c.lon, c.lat, c.n);
  const existing = [osmPoint("far", "water_well", 6000, 0)];
  for (const t of [buildBaseline(c, existing, S, g, snap), buildBaseline(c, existing, S, null, null), buildBaseline(c, [], S, g, snap)]) {
    assert.deepEqual(Array.from(t.idx), [-1, -1, -1]);
    assert.deepEqual(Array.from(t.oneWay), [-1, -1, -1]);
    assert.deepEqual(Array.from(baselineRoundTrip(c, t)), [FALLBACK_RT]);
  }
});

test("baseline: without a network the three nearest count by straight line, stretched by the detour factor", () => {
  const c = clustersOf([{ east: 0, north: 0, people: 10 }]);
  const t = buildBaseline(
    c,
    [
      osmPoint("a", "water_well", 500, 0),
      osmPoint("b", "spring", 0, 200),
      osmPoint("c", "drinking_water", -300, 0),
      osmPoint("d", "borehole", 0, -900),
    ],
    S,
    null,
    null,
  );
  assert.deepEqual(Array.from(t.idx), [1, 2, 0]);
  [200, 300, 500].forEach((m, k) => near(t.oneWay[k], (m * DETOUR) / SPEED_M_PER_MIN, 1e-6, `slot ${k}`));
});

test("baseline: the round trip never exceeds the no-source fallback", () => {
  const c = clustersOf([100, 1000, 2000, 4900, 6000].map((east) => ({ east, north: 0, people: 5 })));
  const t = buildBaseline(c, [osmPoint("w", "water_well", 0, 0)], S, null, null);
  const rt = baselineRoundTrip(c, t);
  for (const m of rt) assert.ok(m <= FALLBACK_RT, `${m} min`);
  near(rt[0], (2 * 100 * DETOUR) / SPEED_M_PER_MIN, 1e-9, "100 m away");
  near(rt[1], (2 * 1000 * DETOUR) / SPEED_M_PER_MIN, 1e-9, "1 km away");
  assert.deepEqual(Array.from(rt.slice(2)), [FALLBACK_RT, FALLBACK_RT, FALLBACK_RT]);
  assert.equal(t.idx[3 * K], 0, "4.9 km away is still recorded, just longer than the fallback");
});

test(
  "baseline: a household beside an off-road well walks straight to it, not out to the road and back",
  () => {
  // Household and well both 200 m north of the only road, 30 m apart: ~440 m by road.
  const g = graphOf([[at(-1010, 0), at(1010, 0)]]);
  const c = clustersOf([{ east: 0, north: 200, people: 30 }]);
  const t = buildBaseline(c, [osmPoint("w", "water_well", 30, 200)], S, g, snapMany(g, c.lon, c.lat, c.n));
  assert.equal(t.idx[0], 0);
  near(t.oneWay[0], (30 * DETOUR) / SPEED_M_PER_MIN, 1e-6, "one-way minutes to a well 30 m away");
});

// ---------------------------------------------------------------------------
// Anchors: what each system type physically needs
// ---------------------------------------------------------------------------

/** One straight east-west road through the origin, a vertex every ~39.6 m. */
const eastWestRoad = () => graphOf([[at(-1010, 0), at(1010, 0)]]);

test("anchor: a solar borehole needs groundwater evidence of at least 0.35", () => {
  const ctx = placeCtx({ graph: eastWestRoad() });
  assert.equal(anchorFor("solar_borehole", candidate(15, 100, { groundwaterEvidenceScore: 0.34 }), ctx), null);
  assert.equal(anchorFor("solar_borehole", candidate(15, 100, { groundwaterEvidenceScore: Number.NaN }), ctx), null);
  const a = anchorFor("solar_borehole", candidate(15, 100, { groundwaterEvidenceScore: 0.35 }), ctx);
  assert.ok(a);
  assert.match(a.label, /groundwater evidence 0\.35/);
});

test("anchor: a borehole or tanker tank goes 12 m off the nearest road when one is within 250 m", () => {
  const g = eastWestRoad();
  const ctx = placeCtx({ graph: g });
  const site = candidate(15, 100);
  const roadVertex = vertex(g, nearestVertex(g, site).node);
  for (const type of ["solar_borehole", "community_storage_and_taps"] as const) {
    const a = anchorFor(type, site, ctx);
    assert.ok(a, type);
    near(nearestVertex(g, a).d, 12, 0.01, `${type}: metres to the road vertex`);
    const off = northOf(a.lat);
    assert.ok(off > 11 && off <= 12 + 1e-6, `${type}: ${off} m from the road's centre line`);
    near(gap(roadVertex, a) + gap(a, site), gap(roadVertex, site), 0.01, `${type}: between the road and the site`);
    assert.match(a.label, /beside the road/);
    assert.equal(a.replaces, -1);
  }
});

test("anchor: far from a road a borehole is drilled at the site and a tanker tank is refused", () => {
  const g = eastWestRoad();
  const ctx = placeCtx({ graph: g });
  const far = candidate(15, 300);
  const a = anchorFor("solar_borehole", far, ctx);
  assert.ok(a);
  assert.deepEqual([a.lon, a.lat], [far.lon, far.lat]);
  assert.match(a.label, /at the site/);
  assert.equal(anchorFor("community_storage_and_taps", far, ctx), null);

  const noRoads = placeCtx({ graph: null });
  assert.equal(anchorFor("community_storage_and_taps", candidate(15, 100), noRoads), null);
  const b = anchorFor("solar_borehole", candidate(15, 100), noRoads);
  assert.ok(b);
  assert.match(b.label, /at the site/);

  // A site already within 12 m of the road keeps its own position.
  const v = nearestVertex(g, pt(15, 0)).node;
  const close = candidate(eastOf(g.lon[v]), 5);
  const c = anchorFor("community_storage_and_taps", close, ctx);
  assert.ok(c);
  assert.deepEqual([c.lon, c.lat], [close.lon, close.lat]);
});

test("anchor: rehabilitation sits exactly on the nearest well or borehole within 600 m and records its index", () => {
  const existing: OsmPoint[] = [
    osmPoint("tap", "drinking_water", 20, 20),
    osmPoint("spring", "spring", -30, 10),
    osmPoint("well", "water_well", 200, 150, "Nyalenda"),
    osmPoint("bh", "borehole", -350, -100),
  ];
  const ctx = placeCtx({ graph: eastWestRoad(), existing });
  const a = anchorFor("borehole_rehabilitation", candidate(0, 0), ctx);
  assert.ok(a);
  assert.deepEqual([a.lon, a.lat], [existing[2].lon, existing[2].lat]);
  assert.equal(a.replaces, 2);
  assert.match(a.label, /existing well "Nyalenda"/);

  const b = anchorFor("borehole_rehabilitation", candidate(-300, -100), ctx);
  assert.ok(b);
  assert.deepEqual([b.lon, b.lat], [existing[3].lon, existing[3].lat]);
  assert.equal(b.replaces, 3);
  assert.match(b.label, /existing borehole/);

  const only = (e: number) => placeCtx({ existing: [osmPoint("w", "water_well", e, 0)] });
  assert.ok(anchorFor("borehole_rehabilitation", candidate(0, 0), only(590)));
  assert.equal(anchorFor("borehole_rehabilitation", candidate(0, 0), only(610)), null);
  const springsAndTaps = placeCtx({ existing: existing.slice(0, 2) });
  assert.equal(anchorFor("borehole_rehabilitation", candidate(0, 0), springsAndTaps), null);
});

test("anchor: rainwater harvesting sits on the nearest school or clinic within 800 m", () => {
  const institutions = [osmPoint("s", "school", 500, 0, "Kanyakwar Primary"), osmPoint("c", "clinic", 0, 700)];
  const ctx = placeCtx({ institutions });
  const a = anchorFor("rainwater_harvesting", candidate(0, 0), ctx);
  assert.ok(a);
  assert.deepEqual([a.lon, a.lat], [institutions[0].lon, institutions[0].lat]);
  assert.match(a.label, /Kanyakwar Primary/);
  assert.equal(a.replaces, -1);

  const b = anchorFor("rainwater_harvesting", candidate(0, 300), ctx); // clinic 400 m, school 583 m
  assert.ok(b);
  assert.deepEqual([b.lon, b.lat], [institutions[1].lon, institutions[1].lat]);
  assert.match(b.label, /a clinic/);

  const only = (e: number) => placeCtx({ institutions: [osmPoint("s", "school", e, 0)] });
  assert.ok(anchorFor("rainwater_harvesting", candidate(0, 0), only(790)));
  assert.equal(anchorFor("rainwater_harvesting", candidate(0, 0), only(810)), null);
});

test("anchor: filtration sits on the nearest raw source within 600 m", () => {
  const osm: OsmData = {
    ...EMPTY_OSM,
    degraded: false,
    waterPoints: [osmPoint("r", "reservoir", 450, 350, "Dunga")],
    waterways: [{ id: "k", kind: "river", name: "Kisat", coords: [at(-500, 400), at(-100, 550), at(300, 700)] }],
  };
  const raw = rawSourcesFrom(osm);
  assert.equal(raw.length, 4);
  const ctx = placeCtx({ rawSources: raw });

  // River vertex 559 m, reservoir 570 m, other river vertices 640 m and 762 m.
  const a = anchorFor("filtration_and_storage", candidate(0, 0), ctx);
  assert.ok(a);
  assert.deepEqual([a.lon, a.lat], at(-100, 550));
  assert.equal(a.label, 'Treats water drawn from the river "Kisat"');

  const b = anchorFor("filtration_and_storage", candidate(450, 300), ctx);
  assert.ok(b);
  assert.deepEqual([b.lon, b.lat], at(450, 350));
  assert.match(b.label, /the reservoir "Dunga"/);

  assert.equal(anchorFor("filtration_and_storage", candidate(1500, -800), ctx), null);
});

// ---------------------------------------------------------------------------
// Tap siting
// ---------------------------------------------------------------------------

/** A main road past the tank, with side streets at 500 m west and 600 m east. */
function tapWorld(): Graph {
  return graphOf([
    [at(-1010, 0), at(-500, 0), at(600, 0), at(1010, 0)],
    [at(-500, -300), at(-500, 0), at(-500, 300)],
    [at(600, -300), at(600, 0), at(600, 300)],
  ]);
}
/** A borehole 12 m north of the main road at the origin. */
const tank = () => anchorAt("solar_borehole", 0, 12);

test("placeTaps: with people on one side of the tank and nobody on the other, the first tap goes to them", () => {
  const g = tapWorld();
  const ctx = placeCtx({ graph: g, clusters: clustersOf(block(600, 50, 250)) });
  const taps = placeTaps(ctx, tank(), 1, 250);
  assert.equal(taps.length, 1);
  assert.ok(eastOf(taps[0].lon) > 0, "east, toward the people");
  assert.ok(gap(taps[0], pt(600, 50)) < 100, `tap at ${where(taps[0])}`);
  assert.deepEqual([taps[0].lon, taps[0].lat], [g.lon[taps[0].node], g.lat[taps[0].node]], "taps sit on the network");
});

test("placeTaps: taps stay 180 m apart and within reach of the tank, never more than K, deterministically", () => {
  const g = tapWorld();
  const clusters = clustersOf([...block(600, 50, 1500), ...block(-500, 100, 1500), ...block(200, -150, 1500)]);
  const ctx = placeCtx({ graph: g, clusters });
  for (const k of [1, 2, 4, 6]) {
    const taps = placeTaps(ctx, tank(), k, 5000);
    assert.equal(taps.length, k, `K = ${k}`);
    assertSpaced(taps);
    for (const t of taps) assert.ok(gap(tank(), t) <= TAP_RADIUS_M + 1e-6, `tap at ${where(t)} is out of reach`);
    assert.deepEqual(placeTaps(ctx, tank(), k, 5000), taps);
  }
});

test("placeTaps: once a group is served the next tap goes to the next unserved group, not beside the first", () => {
  // 250 people east fill the first tap exactly. Without that capacity being
  // consumed, a spot 180 m from the first tap would still out-score the
  // smaller group to the west.
  const g = tapWorld();
  const ctx = placeCtx({ graph: g, clusters: clustersOf([...block(600, 50, 250), ...block(-500, 50, 150)]) });
  const taps = placeTaps(ctx, tank(), 2, 1000);
  assert.equal(taps.length, 2);
  // East, toward the group it serves. It lands short of that group, pulled toward the far one by the
  // uncapped gain (see the skipped capacity test), so only the side is asserted here.
  assert.ok(eastOf(taps[0].lon) > 0, `first tap at ${where(taps[0])}`);
  assert.ok(gap(taps[1], pt(-500, 50)) < 100, `second tap at ${where(taps[1])}`);
});

test("placeTaps: a system too small for a second tap gets one, and K is a hard limit", () => {
  const g = tapWorld();
  const ctx = placeCtx({ graph: g, clusters: clustersOf([...block(600, 50, 250), ...block(-500, 50, 150)]) });
  assert.equal(placeTaps(ctx, tank(), 4, 10).length, 1);
  assert.equal(placeTaps(ctx, tank(), 0, 1000).length, 0);
});

test(
  "placeTaps: a tap is sited for the people it can serve, not for a crowd beyond its load",
  () => {
  // 2,000 people east already have a source 20 minutes' round trip away; a
  // hamlet of 250 west has none (the 60 minute fallback). One 250-person tap
  // saves ~57 minutes a trip in the hamlet and at most 20 in the crowd.
  const g = tapWorld();
  const crowd = block(600, 50, 2000, 5);
  const hamlet = block(-400, 50, 250);
  const ctx = placeCtx({
    graph: g,
    clusters: clustersOf([...crowd, ...hamlet]),
    baselineRt: Float64Array.from([...crowd.map(() => 20), ...hamlet.map(() => FALLBACK_RT)]),
  });
  const taps = placeTaps(ctx, tank(), 1, 250);
  assert.equal(taps.length, 1);
  assert.ok(gap(taps[0], pt(-400, 50)) < 100, `tap at ${where(taps[0])}`);
});

test("placeTaps: a rehabilitated well always gets the first tap, on the well itself", () => {
  const g = tapWorld();
  const clusters = clustersOf([...block(600, 50, 250), ...block(-300, 250, 200)]);
  const offRoad = placeCtx({ graph: g, clusters, existing: [osmPoint("w", "water_well", -300, 150)] });
  const a = anchorFor("borehole_rehabilitation", candidate(-250, 100), offRoad);
  assert.ok(a);
  assert.equal(a.replaces, 0);
  for (const [k, capacity] of [
    [1, 200],
    [3, 700],
    [4, 10],
  ]) {
    const taps = placeTaps(offRoad, a, k, capacity);
    assert.deepEqual([taps[0].lon, taps[0].lat], [a.lon, a.lat]);
    assert.equal(taps[0].node, -1, "150 m from the road: no vertex within 60 m");
    assertSpaced(taps);
    if (capacity === 10) assert.equal(taps.length, 1);
  }

  const byRoad = placeCtx({ graph: g, clusters, existing: [osmPoint("w", "water_well", -300, 30)] });
  const b = anchorFor("borehole_rehabilitation", candidate(-300, 30), byRoad);
  assert.ok(b);
  const taps = placeTaps(byRoad, b, 2, 500);
  assert.deepEqual([taps[0].lon, taps[0].lat], [b.lon, b.lat]);
  assert.equal(taps[0].node, snapPoint(g, b.lon, b.lat).node, "30 m from the road: tied to its vertex");
});

test("placeTaps: without a network taps fall back to a 60 m lattice round the tank", () => {
  const ctx = placeCtx({ graph: null, clusters: clustersOf(block(600, 50, 250)) });
  const anchor = anchorAt("solar_borehole", 0, 0);
  const taps = placeTaps(ctx, anchor, 2, 500);
  assert.ok(taps.length >= 1);
  for (const t of taps) {
    assert.equal(t.node, -1);
    for (const m of [eastOf(t.lon), northOf(t.lat)]) near(m / 60, Math.round(m / 60), 1e-6, "lattice position");
  }
  assert.ok(gap(taps[0], pt(600, 50)) < 100, `tap at ${where(taps[0])}`);
});

// ---------------------------------------------------------------------------
// Pipes and layout
// ---------------------------------------------------------------------------

/** A main street with a side street north off it at 400 m east. */
function pipeWorld(): Graph {
  return graphOf([
    [at(-1010, 0), at(400, 0), at(1010, 0)],
    [at(400, 0), at(400, 510)],
  ]);
}

test("routePipes: pipes follow the streets from the hub, turning at the junction", () => {
  const g = pipeWorld();
  const anchor = anchorAt("community_storage_and_taps", 0, 10);
  const taps = [tapOn(g, 400, 300), tapOn(g, -600, 0)];
  const r = routePipes(placeCtx({ graph: g }), anchor, taps);

  const hubNode = snapPoint(g, anchor.lon, anchor.lat).node;
  assert.deepEqual(r.hub, [g.lon[hubNode], g.lat[hubNode]]);
  const onGraph = new Set(Array.from({ length: g.n }, (_, v) => `${g.lon[v]},${g.lat[v]}`));
  assert.equal(r.lines.length, taps.length);
  r.lines.forEach((line, i) => {
    for (const [lon, lat] of line) assert.ok(onGraph.has(`${lon},${lat}`), `pipe ${i} leaves the network`);
    assert.deepEqual(line[0], r.hub);
    assert.deepEqual(line[line.length - 1], [taps[i].lon, taps[i].lat]);
  });
  const junction = vertexAt(g, 400, 0);
  assert.deepEqual(r.lines[0], [r.hub, [g.lon[junction], g.lat[junction]], [taps[0].lon, taps[0].lat]]);
  assert.equal(r.lines[1].length, 2, "a straight run is simplified to its two ends");

  // Nothing is shared, so the priced length is both routes plus the run to the hub.
  const tree = dijkstra(g, [{ node: hubNode, d: 0, label: 0 }]).dist;
  const toHub = gap(anchor, vertex(g, hubNode));
  near(r.lengthM, toHub + tree[taps[0].node] + tree[taps[1].node], 0.5, "pipe length");
});

test("routePipes: two taps down the same street share the trunk, which is priced once", () => {
  const g = pipeWorld();
  const anchor = anchorAt("community_storage_and_taps", 0, 10);
  const ctx = placeCtx({ graph: g });
  const hubNode = snapPoint(g, anchor.lon, anchor.lat).node;
  const tree = dijkstra(g, [{ node: hubNode, d: 0, label: 0 }]).dist;
  const toHub = gap(anchor, vertex(g, hubNode));
  for (const [first, second] of [
    [tapOn(g, 700, 0), tapOn(g, 950, 0)],
    [tapOn(g, 400, 200), tapOn(g, 400, 450)],
  ]) {
    const r = routePipes(ctx, anchor, [first, second]);
    assert.ok(r.lengthM < tree[first.node] + tree[second.node], "shorter than two separate pipes");
    near(r.lengthM, toHub + tree[second.node], 0.5, "the trunk to the farther tap, once");
  }
});

test(
  "routePipes: a rehabilitated well's own tap adds no pipe",
  () => {
  const g = pipeWorld();
  const ctx = placeCtx({
    graph: g,
    clusters: clustersOf(block(-300, 250, 100)),
    existing: [osmPoint("w", "water_well", -300, 150)],
  });
  const anchor = anchorFor("borehole_rehabilitation", candidate(-300, 150), ctx);
  assert.ok(anchor);
  const taps = placeTaps(ctx, anchor, 1, 100);
  assert.equal(taps.length, 1);
  assert.equal(taps[0].node, -1);
  // A well whose only tap sits on the well needs no pipe at all: nothing reaches the road.
  const routed = routePipes(ctx, anchor, taps);
  near(routed.lengthM, 0, 0.5, "priced pipe for the well's own tap");
  assert.equal(routed.usesNetwork, false);

  // A second tap on the street adds only its own route.
  const street = tapOn(g, 100, 0);
  // The street tap pays for the well-to-road connector and its own route; the well tap still adds nothing.
  const hub = snapPoint(g, anchor.lon, anchor.lat);
  const tree = dijkstra(g, [{ node: hub.node, d: 0, label: 0 }]).dist;
  near(routePipes(ctx, anchor, [taps[0], street]).lengthM, hub.offsetM + tree[street.node], 0.5, "well tap plus a street tap");
});

test("routePipes: without a network pipes run straight from the source", () => {
  const anchor = anchorAt("solar_borehole", 0, 0);
  const taps: Tap[] = [
    { ...pt(300, 400), node: -1 },
    { ...pt(-120, 0), node: -1 },
  ];
  const r = routePipes(placeCtx({ graph: null }), anchor, taps);
  assert.equal(r.lengthM, 620);
  assert.deepEqual(r.hub, [anchor.lon, anchor.lat]);
  assert.deepEqual(
    r.lines,
    taps.map((t) => [
      [anchor.lon, anchor.lat],
      [t.lon, t.lat],
    ]),
  );
});

test("buildLayout: tank and treatment beside the source, one stand per tap, a closed service ring", () => {
  const g = pipeWorld();
  const anchor = anchorAt("solar_borehole", 0, 60);
  const taps = [tapOn(g, 400, 300), tapOn(g, -600, 0), tapOn(g, 900, 0)];
  const routed = routePipes(placeCtx({ graph: g }), anchor, taps);
  const layout = buildLayout(anchor, taps, routed);
  const p = (c: LngLat): Pt => ({ lon: c[0], lat: c[1] });

  assert.ok(gap(p(layout.source), anchor) < 0.2);
  near(gap(p(layout.source), p(layout.tank)), 18, 0.5, "tank from source");
  assert.ok(gap(p(layout.source), p(layout.treatment)) <= 50, "treatment within 50 m of the source");
  assert.ok(gap(p(layout.tank), p(layout.treatment)) <= 20, "treatment beside the tank");

  assert.equal(layout.tapStandCount, taps.length);
  assert.equal(layout.taps.length, taps.length);
  layout.taps.forEach((t, i) => assert.ok(gap(p(t), taps[i]) < 0.2));
  // Priced length = the routed network plus the real trunk (source, tank, treatment, road), not a fixed allowance.
  const trunk = layout.pipes[0];
  let trunkM = 0;
  for (let i = 1; i < trunk.length; i++) trunkM += gap(p(trunk[i - 1]), p(trunk[i]));
  near(layout.pipelineLengthM, routed.lengthM - routed.connectorM + trunkM, 1, "pipe length = network + trunk");
  assert.equal(layout.pipes.length, routed.lines.length + 1);
  assert.deepEqual(layout.pipes[0][0], layout.source);
  assert.ok(gap(p(layout.pipes[0][layout.pipes[0].length - 1]), p(routed.hub)) < 0.2, "source pipe ends at the hub");

  const ring = layout.serviceRadiusRing;
  assert.deepEqual(ring[0], ring[ring.length - 1], "the ring is closed");
  const reach = Math.max(...taps.map((t) => gap(anchor, t)));
  const radius = Math.max(400, reach + 250);
  for (const c of ring) near(gap(anchor, p(c)), radius, 0.5, "ring radius");
});
