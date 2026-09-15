/**
 * Re-run the preset towns through the full pipeline with the precompute
 * simulation settings, refreshing data/runs (the replay cache) and data/demo
 * (the offline fallback).
 *
 * It first runs exactly as the app does live, so the simulation gets every
 * building from the town query. If that query fails it reuses the cached map,
 * climate and terrain layers instead. A run is only saved when the map loaded
 * and the simulation used real building detail, so a flaky provider can never
 * overwrite a good snapshot.
 *   npm run recache [-- slug ...]
 */
import { copyFileSync, readFileSync } from "node:fs";
import type { AnalysisEvent, AnalysisRun, TrackId } from "@/lib/types";
import { runAnalysis, type RunOptions } from "@/lib/pipeline";
import { saveRun } from "@/lib/cache/cache";
import { PRECOMPUTE_OPTIONS } from "@/lib/popsim/scenarios";

const DEFAULT = ["kisumu-kenya", "gulu-uganda", "tamale-ghana"];

async function attempt(prev: AnalysisRun, slug: string, options: RunOptions): Promise<AnalysisRun> {
  const events: AnalysisEvent[] = [];
  let seq = 0;
  const emit = (track: TrackId, message: string, status: AnalysisEvent["status"], sourceCount?: number) => {
    events.push({
      id: `e${String(seq++).padStart(3, "0")}`,
      track,
      message,
      ts: Date.now(),
      status,
      ...(sourceCount !== undefined ? { sourceCount } : {}),
    });
    console.log(`[${slug}] ${track}: ${message}`);
  };
  const run = await runAnalysis(prev.town, emit, options);
  run.events = events;
  return run;
}

const usable = (run: AnalysisRun) =>
  !run.osm.degraded && run.simulation !== null && run.simulation.buildingSource !== "sample" && run.simulation.recommendedId !== null;

async function main(): Promise<void> {
  const slugs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  // Cached layers by default (the town-wide query is the heaviest call we make); --live re-fetches them.
  const preloadedOnly = !process.argv.includes("--live");
  for (const slug of slugs.length ? slugs : DEFAULT) {
    const prev = JSON.parse(readFileSync(`data/runs/${slug}.json`, "utf8")) as AnalysisRun;
    const t0 = Date.now();
    let run: AnalysisRun | null = null;
    if (!preloadedOnly) {
      run = await attempt(prev, slug, { simulation: PRECOMPUTE_OPTIONS });
      if (!usable(run)) console.log(`[${slug}] live layers unusable; retrying with the cached layers`);
    }
    if (!run || !usable(run)) {
      run = await attempt(prev, slug, {
        simulation: PRECOMPUTE_OPTIONS,
        preloaded: { osm: prev.osm, climate: prev.climate, terrain: prev.terrain },
      });
    }
    if (!usable(run)) {
      console.log(`[${slug}] NOT SAVED: no usable simulation (source ${run.simulation?.buildingSource ?? "none"}); the previous snapshot is kept`);
      continue;
    }
    if (!(await saveRun(run))) throw new Error(`could not save ${slug}`);
    copyFileSync(`data/runs/${slug}.json`, `data/demo/${slug}.json`);
    if (slug === "kisumu-kenya") copyFileSync(`data/runs/${slug}.json`, "data/demo/default.json");
    const p = run.simulation!.projects[0];
    console.log(
      `[${slug}] saved in ${Math.round((Date.now() - t0) / 1000)} s · ${run.simulation!.buildingSource} buildings · ${run.simulation!.householdClusters} clusters · ${p.label} held ${p.futures?.passed}/${p.futures?.run}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
