import { NextResponse } from "next/server";
import { discoverPartners } from "@/lib/partners/discover";
import { verifiedPartnersFor } from "@/lib/partners/verified";
import { matchPartners, resourceNeedFor } from "@/lib/partners/match";
import { loadCachedRun, loadDemoRun } from "@/lib/cache/cache";
import type { AnalysisRun } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/match { run } — best-fit partner organisations for a run the
 * client already holds (works for live runs on a read-only host, same
 * reasoning as POST /api/brief).
 *
 * GET /api/match?slug=<slug>[&live=0] — same, for a stored run.
 *
 * Ranks candidate partners against the winning recommendation's resource
 * need (intervention type, cost tier) — see lib/partners/match.ts for what
 * "best match" does and, importantly, does not claim about any partner.
 */
async function respond(run: AnalysisRun, skipLive: boolean) {
  const need = resourceNeedFor(run);
  if (!need) {
    return NextResponse.json({ error: "This run has no recommendation to match against" }, { status: 422 });
  }

  const country = run.town.country;
  const candidates = skipLive
    ? verifiedPartnersFor(need.countryIso2)
    : (run.partners ?? (await discoverPartners(country)).partners);

  const matches = matchPartners(need, candidates);
  return NextResponse.json({ need, matches });
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const slug = params.get("slug");
  if (!slug) return NextResponse.json({ error: "Missing ?slug=" }, { status: 400 });

  const run = (await loadCachedRun(slug)) ?? (await loadDemoRun(slug));
  if (!run) return NextResponse.json({ error: "No stored run for that town" }, { status: 404 });

  return respond(run, params.get("live") === "0");
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { run?: AnalysisRun } | null;
  if (!body?.run) return NextResponse.json({ error: "Missing { run } in request body" }, { status: 400 });
  return respond(body.run, false);
}
