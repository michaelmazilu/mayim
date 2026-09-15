/**
 * Refresh saved live-evidence snapshots for the demo towns.
 *
 *   npm run evidence:refresh                      # kisumu-kenya gulu-uganda tamale-ghana
 *   npm run evidence:refresh -- nakuru-kenya      # any town with a stored run
 *
 * Reads EXA_API_KEY (and optionally OPENAI_API_KEY) from .env.local, runs the
 * same Exa queries and partner search as a live analysis, and writes
 * data/evidence/<slug>.json. Commit those files: they are what a keyless demo
 * or an Exa outage falls back to.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { TownRef } from "@/lib/types";
import { isExaConfigured, searchEvidenceDetailed } from "@/lib/evidence/exa";
import { structureLive } from "@/lib/evidence/gather";
import { saveEvidenceSnapshot } from "@/lib/evidence/snapshot";
import { discoverPartners } from "@/lib/partners/discover";

const DEFAULT_SLUGS = ["kisumu-kenya", "gulu-uganda", "tamale-ghana"];

async function townFor(slug: string): Promise<TownRef | null> {
  for (const dir of ["runs", "demo"]) {
    try {
      const raw = await fs.readFile(path.join(process.cwd(), "data", dir, `${slug}.json`), "utf8");
      const town = (JSON.parse(raw) as { town?: TownRef }).town;
      if (town?.slug === slug) return town;
    } catch {
      /* try the next directory */
    }
  }
  return null;
}

async function refresh(slug: string): Promise<boolean> {
  const town = await townFor(slug);
  if (!town) {
    console.error(`✗ ${slug}: no stored run in data/runs or data/demo — run the town once in the app first.`);
    return false;
  }

  const [search, partners] = await Promise.all([searchEvidenceDetailed(town), discoverPartners(town.country)]);
  console.log(`\n${town.displayName}`);
  for (const o of search.outcomes) {
    console.log(`  ${o.tier.padEnd(5)} ${o.category.padEnd(14)} ${String(o.results).padStart(2)} hits${o.error ? `  (${o.error})` : ""}`);
  }
  console.log(`  partners      ${partners.found} found by search (${partners.status})${partners.error ? `  (${partners.error})` : ""}`);

  if (search.status !== "ok") {
    console.error(`✗ ${slug}: no usable sources (${search.status}${search.error ? `: ${search.error}` : ""}). Snapshot not written.`);
    return false;
  }

  const { findings, structuredBy } = await structureLive(town, search.items);
  const ok = await saveEvidenceSnapshot({
    version: 1,
    slug,
    displayName: town.displayName,
    retrievedAt: new Date().toISOString(),
    structuredBy,
    queries: search.outcomes,
    findings,
    partners: partners.partners,
  });
  console.log(`${ok ? "✓" : "✗"} ${slug}: ${findings.length} findings (${structuredBy}) → data/evidence/${slug}.json`);
  return ok;
}

async function main() {
  if (!isExaConfigured()) {
    console.error("EXA_API_KEY is not set. Add it to .env.local (see .env.example).");
    process.exit(1);
  }
  const slugs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const results = [];
  for (const slug of slugs.length ? slugs : DEFAULT_SLUGS) results.push(await refresh(slug));
  process.exit(results.every(Boolean) ? 0 : 1);
}

void main();
