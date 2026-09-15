/**
 * Re-run the demo towns end to end and overwrite their bundled snapshots.
 *
 *   npm run demo:recache                         # kisumu-kenya gulu-uganda tamale-ghana
 *   npm run demo:recache -- gulu-uganda          # one town
 *   npm run demo:recache -- --out /tmp/demo      # dry run into another folder
 *   npm run demo:recache -- --force              # save even if the run looks broken
 *
 * Runs exactly what /api/analyze runs (same pipeline, same event log), so a
 * replayed demo shows the real sequence. Uses .env.local keys when present;
 * without them research falls back to data/evidence snapshots. default.json —
 * the generic fallback snapshot — is kept identical to Kisumu.
 *
 * Commit the rewritten data/demo/*.json afterwards.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AnalysisEvent, AnalysisRun, TownRef, TrackId } from "@/lib/types";
import { runAnalysis } from "@/lib/pipeline";

const DEMO_DIR = path.join(process.cwd(), "data", "demo");
const DEFAULT_SLUGS = ["kisumu-kenya", "gulu-uganda", "tamale-ghana"];
/** data/demo/default.json mirrors this town. */
const DEFAULT_SOURCE = "kisumu-kenya";

async function townFor(slug: string): Promise<TownRef | null> {
  try {
    const raw = await fs.readFile(path.join(DEMO_DIR, `${slug}.json`), "utf8");
    const town = (JSON.parse(raw) as { town?: TownRef }).town;
    return town?.slug === slug ? town : null;
  } catch {
    return null;
  }
}

/** Reasons a run should not replace a working demo snapshot. */
function problemsWith(run: AnalysisRun): string[] {
  const problems: string[] = [];
  if (run.osm.degraded) problems.push("OpenStreetMap came back degraded");
  if (!run.recommendation) problems.push("no recommendation was produced");
  if (run.candidates.length === 0) problems.push("no candidate sites");
  return problems;
}

async function recache(slug: string, outDir: string, force: boolean): Promise<boolean> {
  const town = await townFor(slug);
  if (!town) {
    console.error(`✗ ${slug}: no data/demo/${slug}.json to take the town from`);
    return false;
  }

  // Same event shape as app/api/analyze/route.ts, so replay works unchanged.
  const events: AnalysisEvent[] = [];
  let seq = 0;
  const emit = (track: TrackId, message: string, status: AnalysisEvent["status"], sourceCount?: number) => {
    events.push({
      id: `e${(seq++).toString().padStart(3, "0")}`,
      track,
      message,
      ts: Date.now(),
      status,
      ...(sourceCount !== undefined ? { sourceCount } : {}),
    });
  };

  const t0 = Date.now();
  const run = await runAnalysis(town, emit);
  run.events = events;
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);

  const problems = problemsWith(run);
  if (problems.length && !force) {
    console.error(`✗ ${slug}: not saved (${problems.join("; ")}). Re-run, or pass --force.`);
    return false;
  }

  await fs.mkdir(outDir, { recursive: true });
  const body = JSON.stringify(run);
  await fs.writeFile(path.join(outDir, `${slug}.json`), body, "utf8");
  if (slug === DEFAULT_SOURCE) await fs.writeFile(path.join(outDir, "default.json"), body, "utf8");

  const rec = run.recommendation;
  const p = run.population;
  const file = path.join(outDir, `${slug}.json`);
  const shown = path.relative(process.cwd(), file);
  console.log(
    `✓ ${slug} in ${seconds} s → ${shown.startsWith("..") ? file : shown}` +
      (slug === DEFAULT_SOURCE ? " (+ default.json)" : ""),
  );
  console.log(`    evidence ${run.evidenceProvenance ?? "bundled"} · ${run.findings.length} findings · ${run.partners?.length ?? 0} partners`);
  console.log(`    population ${p.method} ${p.rangeLow.toLocaleString()}–${p.rangeHigh.toLocaleString()}`);
  if (rec) {
    console.log(`    ${rec.label} · $${rec.cost.totalLow.toLocaleString()}–$${rec.cost.totalHigh.toLocaleString()} · ${run.ranked.length} viable sites`);
  }
  if (problems.length) console.log(`    saved despite: ${problems.join("; ")}`);
  if (run.warnings.length) console.log(`    ${run.warnings.length} warning(s): ${run.warnings[0]}`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 && args[outIndex + 1] ? path.resolve(args[outIndex + 1]) : DEMO_DIR;
  const slugs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");

  const results: boolean[] = [];
  for (const slug of slugs.length ? slugs : DEFAULT_SLUGS) results.push(await recache(slug, outDir, force));
  process.exit(results.every(Boolean) ? 0 : 1);
}

void main();
