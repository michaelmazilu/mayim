import { promises as fs } from "node:fs";
import path from "node:path";
import type { AnalysisRun, TownRef } from "@/lib/types";

const RUNS_DIR = path.join(process.cwd(), "data", "runs");
const DEMO_DIR = path.join(process.cwd(), "data", "demo");

/** Deterministic cache key: "kisumu-kenya". */
export function townSlug(name: string, country?: string): string {
  return [name, country]
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function readRun(dir: string, slug: string): Promise<AnalysisRun | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${slug}.json`), "utf8");
    const parsed = JSON.parse(raw) as AnalysisRun;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** A previously saved live run for this town. */
export async function loadCachedRun(slug: string): Promise<AnalysisRun | null> {
  const run = await readRun(RUNS_DIR, slug);
  return run ? { ...run, provenance: "cache" } : null;
}

/** Bundled snapshot — the town-specific one, else the generic fallback. */
export async function loadDemoRun(slug: string): Promise<AnalysisRun | null> {
  const run = (await readRun(DEMO_DIR, slug)) ?? (await readRun(DEMO_DIR, "default"));
  return run ? { ...run, provenance: "demo" } : null;
}

/** Best-effort persist. A read-only filesystem must never break a run. */
export async function saveRun(run: AnalysisRun): Promise<boolean> {
  try {
    await fs.mkdir(RUNS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(RUNS_DIR, `${run.town.slug}.json`),
      JSON.stringify(run),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

export async function listCachedSlugs(): Promise<string[]> {
  try {
    const files = await fs.readdir(RUNS_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Retarget a bundled demo run onto the town the user actually asked for, so the
 * map still flies to the right place when we are running without any API keys.
 * The analysis payload is unchanged and stays labelled `demo`.
 */
export function rebaseDemoRun(run: AnalysisRun, town: TownRef): AnalysisRun {
  if (run.town.slug === town.slug) return run;
  const [dLon, dLat] = [town.center[0] - run.town.center[0], town.center[1] - run.town.center[1]];
  const shift = <T extends { lon: number; lat: number }>(o: T): T => ({
    ...o,
    lon: o.lon + dLon,
    lat: o.lat + dLat,
  });
  return {
    ...run,
    town,
    candidates: run.candidates.map(shift),
    warnings: [
      ...run.warnings,
      `Geospatial layers in this snapshot were analysed for ${run.town.displayName} and repositioned onto ${town.displayName}. Run live research for a real analysis of this town.`,
    ],
  };
}
