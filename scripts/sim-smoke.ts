/** node --import tsx scripts/sim-smoke.ts <slug> [precompute] */
import { readFileSync } from "node:fs";
import type { AnalysisRun } from "@/lib/types";
import { defaultRates } from "@/lib/popsim/engine";
import { LIVE_OPTIONS, PRECOMPUTE_OPTIONS, runSimulation } from "@/lib/popsim/scenarios";
import { fetchLocalOsm } from "@/lib/providers/local-osm";

async function main(): Promise<void> {
  const slug = process.argv[2] ?? "gulu-uganda";
  const run = JSON.parse(readFileSync(`data/runs/${slug}.json`, "utf8")) as AnalysisRun;
  const t0 = Date.now();
  let tf = 0;
  const { result, best } = await runSimulation(
    { town: run.town, osm: run.osm, climate: run.climate, candidates: run.candidates, ranked: run.ranked, rates: defaultRates() },
    process.argv[3] === "precompute" ? PRECOMPUTE_OPTIONS : LIVE_OPTIONS,
    { fetchLocal: async (c, o) => { if (process.env.OFFLINE) return { buildings: [], buildingWeight: 1, paths: [], ok: false }; const s = Date.now(); const r = await fetchLocalOsm(c, o); tf = Date.now() - s; return r; } },
    (m) => console.log(`  · ${m}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`),
  );
  console.log({ totalS: (Date.now() - t0) / 1000, fetchS: tf / 1000, screened: result.screened, detailed: result.detailed, stress: result.stressTested, clusters: result.householdClusters, buildings: result.buildings, source: result.buildingSource, replayN: result.replay?.n, replayKB: Math.round(JSON.stringify(result.replay ?? {}).length / 1024) });
  for (const p of result.projects.slice(0, 12)) {
    console.log(`${p.id === result.recommendedId ? "★" : " "} ${p.type.padEnd(27)} $${String(p.costPerPersonServed).padStart(5)}/p  served ${String(p.peopleServed).padStart(5)}  <30m ${String(p.peopleUnder30Min).padStart(5)}  hrs/d ${String(p.hoursSavedPerDay).padStart(4)}  taps ${p.tapCount} pipe ${p.pipelineLengthM}m  held ${p.futures ? `${p.futures.passed}/${p.futures.run}` : "—"}  cap ${p.futures?.capacityYear ?? "—"}  | ${p.anchor}`);
  }
  if (best) console.log("layout taps", best.layout.taps, "pipes", best.layout.pipes.length, "pts", best.layout.pipes.reduce((a, l) => a + l.length, 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
