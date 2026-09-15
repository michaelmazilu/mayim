import type { AnalysisRun } from "@/lib/types";
import { loadCachedRun, loadDemoRun } from "@/lib/cache/cache";
import { buildProjectBrief } from "@/lib/brief/brief";
import { verifiedPartnersFor } from "@/lib/partners/verified";
import { countryIso2 } from "@/lib/geo/countries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A full run is ~1.5 MB of JSON; anything far beyond that is not a run. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function markdown(run: AnalysisRun, download: boolean): Response {
  const partners = run.partners?.length ? run.partners : verifiedPartnersFor(countryIso2(run.town.country));
  const body = buildProjectBrief(run, { partners });
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
      ...(download ? { "Content-Disposition": `attachment; filename="mayim-brief-${run.town.slug}.md"` } : {}),
    },
  });
}

function looksLikeRun(value: unknown): value is AnalysisRun {
  const r = value as Partial<AnalysisRun> | null;
  return Boolean(
    r &&
      r.version === 1 &&
      typeof r.town?.slug === "string" &&
      typeof r.town.displayName === "string" &&
      Array.isArray(r.candidates) &&
      Array.isArray(r.findings) &&
      Array.isArray(r.dataSources) &&
      r.population,
  );
}

/** GET /api/brief?slug=kisumu-kenya[&download=1] — brief for a stored run. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const slug = params.get("slug");
  if (!slug) return new Response("Missing ?slug=", { status: 400 });
  const run = (await loadCachedRun(slug)) ?? (await loadDemoRun(slug));
  // loadDemoRun falls back to a generic snapshot — never brief the wrong town.
  if (!run || run.town.slug !== slug) return new Response("No stored run for that town", { status: 404 });
  return markdown(run, params.get("download") === "1");
}

/** POST /api/brief { run } — brief for the run the client already holds (live runs on a read-only host). */
export async function POST(req: Request) {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return new Response("Body too large", { status: 413 });
  let body: { run?: unknown };
  try {
    body = (await req.json()) as { run?: unknown };
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!looksLikeRun(body.run)) return new Response("Missing or malformed run", { status: 400 });
  return markdown(body.run, new URL(req.url).searchParams.get("download") === "1");
}
