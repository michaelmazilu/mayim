/**
 * Full-detail OpenStreetMap around a handful of sites: every building centroid
 * and every walkable way (including footpaths), for the household simulation.
 * The town-wide query caps buildings at a few thousand, which near a site can
 * mean one mapped building standing for forty; this does not.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LngLat } from "@/lib/types";
import { fetchWithTimeout } from "@/lib/providers/fetchWithTimeout";

/** Successful answers are kept on disk: the same query is never sent twice. */
const CACHE_DIR = path.join(process.cwd(), "data", "cache", "overpass");

async function cached(query: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(CACHE_DIR, `${createHash("sha1").update(query).digest("hex")}.txt`), "utf8");
  } catch {
    return null;
  }
}

async function remember(query: string, text: string): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${createHash("sha1").update(query).digest("hex")}.txt`), text, "utf8");
  } catch {
    /* read-only filesystem: just uncached */
  }
}

export type Circle = { lon: number; lat: number; radiusM: number };
export type LocalOsm = {
  buildings: { lon: number; lat: number }[];
  /** Real buildings each kept centroid stands for; above 1 only when the cap was hit. */
  buildingWeight: number;
  paths: LngLat[][];
  ok: boolean;
  note?: string;
};

/** The mirror first: the heavy full-detail queries time out on the busier main instance. */
const ENDPOINTS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter"];
const UA = "Mayim/1.0 (hackathon pre-feasibility demo)";
const WALK_RE =
  "^(trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|pedestrian|track|path|footway|road|steps)$";
const MAX_BUILDINGS = 80_000;
const TIMEOUT_MS = 60_000;

/**
 * Asks each server in turn until one answers or the deadline passes, backing
 * off between rounds: the public instances throttle busy clients with 429s
 * and gateway timeouts that clear after a short wait.
 */
async function overpassText(query: string, order: string[], deadline: number): Promise<string | null> {
  const hit = await cached(query);
  if (hit) return hit;
  for (let round = 0; Date.now() < deadline; round++) {
    for (const url of order) {
      if (Date.now() >= deadline) return null;
      try {
        const res = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
            body: `data=${encodeURIComponent(query)}`,
            cache: "no-store",
          },
          Math.max(1000, Math.min(TIMEOUT_MS, deadline - Date.now())),
        );
        if (res.ok) {
          const text = await res.text();
          if (!text.trimStart().startsWith("<")) {
            await remember(query, text);
            return text;
          }
        }
      } catch {
        /* next server */
      }
    }
    await new Promise((r) => setTimeout(r, Math.min(15_000, 3_000 * (round + 1))));
  }
  return null;
}

function aroundUnion(selector: string, circles: Circle[]): string {
  return circles
    .map((c) => `  ${selector}(around:${Math.round(c.radiusM)},${c.lat.toFixed(6)},${c.lon.toFixed(6)});`)
    .join("\n");
}

function parseCsvPoints(text: string): { lon: number; lat: number }[] {
  const out: { lon: number; lat: number }[] = [];
  for (const line of text.split("\n")) {
    const [a, b] = line.split("\t");
    const lat = Number(a);
    const lon = Number(b);
    if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) out.push({ lon, lat });
  }
  return out;
}

export async function fetchLocalOsm(
  circles: Circle[],
  opts: { buildings?: boolean; budgetMs?: number } = {},
): Promise<LocalOsm> {
  const wantBuildings = opts.buildings !== false;
  const budgetMs = opts.budgetMs ?? 90_000;
  if (circles.length === 0) {
    return { buildings: [], buildingWeight: 1, paths: [], ok: false, note: "No sites to fetch around." };
  }

  // The two queries go to different servers at the same time: each public
  // instance allows only a couple of concurrent slots per client.
  const deadline = Date.now() + budgetMs;
  const [bText, wText] = await Promise.all([
    !wantBuildings ? Promise.resolve(null) : overpassText(
      `[out:csv(::lat,::lon;false)][timeout:60];\n(\n${aroundUnion('way["building"]', circles)}\n);\nout center qt;`,
      ENDPOINTS,
      deadline,
    ),
    overpassText(
      `[out:json][timeout:60];\n(\n${aroundUnion(`way["highway"~"${WALK_RE}"]`, circles)}\n);\nout geom qt;`,
      [...ENDPOINTS].reverse(),
      deadline,
    ),
  ]);

  let buildings = bText ? parseCsvPoints(bText) : [];
  let buildingWeight = 1;
  if (buildings.length > MAX_BUILDINGS) {
    buildingWeight = buildings.length / MAX_BUILDINGS;
    const kept: { lon: number; lat: number }[] = [];
    for (let i = 0; i < MAX_BUILDINGS; i++) kept.push(buildings[Math.floor((i * buildings.length) / MAX_BUILDINGS)]);
    buildings = kept;
  }

  const paths: LngLat[][] = [];
  if (wText) {
    try {
      const json = JSON.parse(wText) as { elements?: { geometry?: { lat?: number; lon?: number }[] }[] };
      for (const el of json.elements ?? []) {
        const line: LngLat[] = [];
        for (const g of el.geometry ?? []) {
          if (typeof g.lon === "number" && typeof g.lat === "number") line.push([g.lon, g.lat]);
        }
        if (line.length >= 2) paths.push(line);
      }
    } catch {
      /* treated as no paths */
    }
  }

  const ok = wantBuildings ? buildings.length > 0 : paths.length > 0;
  return {
    buildings,
    buildingWeight,
    paths,
    ok,
    note: ok
      ? undefined
      : "Full-detail OpenStreetMap buildings could not be fetched; the simulation fell back to the town-wide sample.",
  };
}
