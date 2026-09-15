import { NextResponse } from "next/server";
import { countryIso3 } from "@/lib/geo/countries";
import { fetchDistrictStatus } from "@/lib/providers/wpdx";
import { buildRegionalScan } from "@/lib/scan/regional";
import { loadScanSnapshot, saveScanSnapshot } from "@/lib/scan/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/scan?country=Uganda
 * Districts ranked by people who would regain water access if broken points
 * were repaired (WPdx+). Falls back to the saved scan when WPdx is unreachable.
 */
export async function GET(req: Request) {
  const country = new URL(req.url).searchParams.get("country")?.trim();
  const iso3 = countryIso3(country);
  if (!country || !iso3) {
    return NextResponse.json({ error: "Unknown or missing ?country=" }, { status: 400 });
  }

  const rows = await fetchDistrictStatus(iso3);
  if (rows && rows.length > 0) {
    const scan = buildRegionalScan({ country, iso3, rows, retrievedAt: new Date() });
    await saveScanSnapshot(scan);
    return NextResponse.json({ provenance: "live", scan });
  }

  const saved = await loadScanSnapshot(iso3);
  if (saved) {
    const note = rows === null ? "WPdx unreachable — saved scan shown" : "WPdx returned no rows — saved scan shown";
    return NextResponse.json({ provenance: "snapshot", note, scan: saved });
  }
  if (rows && rows.length === 0) {
    return NextResponse.json({ error: `WPdx has no surveyed water points for ${country}` }, { status: 404 });
  }
  return NextResponse.json({ error: "WPdx unreachable and no saved scan for this country" }, { status: 503 });
}
