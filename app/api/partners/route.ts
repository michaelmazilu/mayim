import { NextResponse } from "next/server";
import { discoverPartners } from "@/lib/partners/discover";
import { verifiedPartnersFor } from "@/lib/partners/verified";
import { countryIso2 } from "@/lib/geo/countries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/partners?country=Kenya[&live=0]
 * Verified organisations for the country plus, when EXA_API_KEY is set and
 * live is not disabled, organisations found by search this request.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const country = params.get("country")?.trim() || undefined;
  const iso2 = countryIso2(country);

  if (params.get("live") === "0") {
    return NextResponse.json({ country: country ?? null, iso2: iso2 ?? null, partners: verifiedPartnersFor(iso2), search: { status: "skipped", found: 0 } });
  }
  const { partners, ...search } = await discoverPartners(country);
  return NextResponse.json({ country: country ?? null, iso2: iso2 ?? null, partners, search });
}
