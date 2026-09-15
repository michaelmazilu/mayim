/**
 * Refresh saved regional scans (data/scan/<ISO3>.json) from WPdx+.
 *
 *   npm run scan:refresh                 # Kenya, Uganda, Ghana
 *   npm run scan:refresh -- Nigeria      # any country WPdx covers
 *
 * No key needed. Commit the files: they are the fallback when WPdx is down.
 */

import { countryIso3 } from "@/lib/geo/countries";
import { fetchDistrictStatus } from "@/lib/providers/wpdx";
import { buildRegionalScan } from "@/lib/scan/regional";
import { saveScanSnapshot } from "@/lib/scan/snapshot";

const DEFAULT_COUNTRIES = ["Kenya", "Uganda", "Ghana"];

async function refresh(country: string): Promise<boolean> {
  const iso3 = countryIso3(country);
  if (!iso3) {
    console.error(`✗ ${country}: unknown country`);
    return false;
  }
  const rows = await fetchDistrictStatus(iso3);
  if (!rows || rows.length === 0) {
    console.error(`✗ ${country}: ${rows === null ? "WPdx unreachable" : "no WPdx data"}`);
    return false;
  }
  const scan = buildRegionalScan({ country, iso3, rows, retrievedAt: new Date() });
  const ok = await saveScanSnapshot(scan);
  const t = scan.totals;
  console.log(
    `\n${ok ? "✓" : "✗"} ${country} (${iso3}): ${t.districts} districts, ${t.total.toLocaleString()} water points, ` +
      `${t.wouldRegainAccess.toLocaleString()} people would regain access → data/scan/${iso3}.json`,
  );
  for (const d of scan.districts.slice(0, 5)) {
    const share = d.notWorkingShare === null ? "n/a" : `${Math.round(d.notWorkingShare * 100)}%`;
    console.log(
      `  ${String(d.rank).padStart(2)}. ${d.district.padEnd(18)} ${d.wouldRegainAccess.toLocaleString().padStart(8)} people · ` +
        `${share} not working · ${d.waterPoints.total} points · latest ${d.latestReport ?? "n/a"}` +
        (d.flags.length ? ` [${d.flags.join(", ")}]` : ""),
    );
  }
  return ok;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const results = [];
  for (const country of args.length ? args : DEFAULT_COUNTRIES) results.push(await refresh(country));
  process.exit(results.every(Boolean) ? 0 : 1);
}

void main();
