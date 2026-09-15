/**
 * Saved regional scans (data/scan/<ISO3>.json) — the fallback when WPdx is
 * unreachable. Written by `npm run scan:refresh` and, best-effort, by every
 * successful live scan.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { RegionalScan } from "@/lib/scan/regional";

const SCAN_DIR = path.join(process.cwd(), "data", "scan");

function fileFor(iso3: string): string {
  return path.join(SCAN_DIR, `${iso3.toUpperCase().replace(/[^A-Z]/g, "")}.json`);
}

export async function loadScanSnapshot(iso3: string): Promise<RegionalScan | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(fileFor(iso3), "utf8")) as RegionalScan;
    return parsed?.version === 1 && Array.isArray(parsed.districts) ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort persist. A read-only filesystem must never break a request. */
export async function saveScanSnapshot(scan: RegionalScan): Promise<boolean> {
  try {
    await fs.mkdir(SCAN_DIR, { recursive: true });
    await fs.writeFile(fileFor(scan.iso3), `${JSON.stringify(scan, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
