import { NextResponse } from "next/server";
import { listCachedSlugs, loadCachedRun, loadDemoRun } from "@/lib/cache/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ cached: await listCachedSlugs() });
  }
  const run = (await loadCachedRun(slug)) ?? (await loadDemoRun(slug));
  if (!run) return NextResponse.json({ error: "No stored run for that town" }, { status: 404 });
  return NextResponse.json({ run });
}
