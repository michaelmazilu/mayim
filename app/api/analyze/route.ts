import type { AnalysisEvent, AnalysisRun, TownRef, TrackId } from "@/lib/types";
import { loadCachedRun, loadDemoRun, rebaseDemoRun, saveRun } from "@/lib/cache/cache";
import { runAnalysis } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const enc = new TextEncoder();

function sse(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) {
  controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Replays a stored run's real events with their original relative spacing
 * (compressed into ~4.5 s) so a cached town still shows the analysis sequence.
 * These are genuine saved events, not synthetic animation.
 */
async function replay(
  controller: ReadableStreamDefaultController<Uint8Array>,
  run: AnalysisRun,
  signal: AbortSignal,
) {
  const evs = run.events;
  if (evs.length === 0) {
    sse(controller, "done", run);
    return;
  }
  const span = Math.max(1, evs[evs.length - 1].ts - evs[0].ts);
  const scale = Math.min(1, 4500 / span);
  for (let i = 0; i < evs.length; i++) {
    if (signal.aborted) return;
    sse(controller, "progress", evs[i]);
    const gap = i + 1 < evs.length ? (evs[i + 1].ts - evs[i].ts) * scale : 0;
    await sleep(Math.min(700, Math.max(90, gap)));
  }
  sse(controller, "done", run);
}

export async function POST(req: Request) {
  let body: { town?: TownRef; force?: boolean };
  try {
    body = (await req.json()) as { town?: TownRef; force?: boolean };
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const town = body.town;
  if (!town?.slug || !Array.isArray(town.center) || town.center.length !== 2) {
    return new Response("Missing or malformed town", { status: 400 });
  }
  const force = body.force === true;
  const signal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        // 2. Cached completed run for this town.
        if (!force) {
          const cached = await loadCachedRun(town.slug);
          if (cached) {
            sse(controller, "meta", { provenance: "cache" });
            await replay(controller, cached, signal);
            close();
            return;
          }
          // 3. A committed snapshot of this exact town (the preset towns): instant, and
          //    reliable on hosts with no local run cache. "Re-run live research" forces live.
          const snapshot = await loadDemoRun(town.slug);
          if (snapshot && snapshot.town.slug === town.slug && snapshot.simulation) {
            sse(controller, "meta", { provenance: "demo" });
            await replay(controller, snapshot, signal);
            close();
            return;
          }
        }

        // 1. Live analysis.
        sse(controller, "meta", { provenance: "live" });
        const events: AnalysisEvent[] = [];
        let seq = 0;
        const emit = (track: TrackId, message: string, status: AnalysisEvent["status"], sourceCount?: number) => {
          const ev: AnalysisEvent = {
            id: `e${(seq++).toString().padStart(3, "0")}`,
            track,
            message,
            ts: Date.now(),
            status,
            ...(sourceCount !== undefined ? { sourceCount } : {}),
          };
          events.push(ev);
          if (!signal.aborted) sse(controller, "progress", ev);
        };

        try {
          const run = await runAnalysis(town, emit);
          run.events = events;
          await saveRun(run);
          sse(controller, "done", run);
        } catch (err) {
          // 3. Bundled demo snapshot.
          const message = err instanceof Error ? err.message : "unknown error";
          const demo = await loadDemoRun(town.slug);
          if (demo) {
            sse(controller, "meta", { provenance: "demo", note: message });
            const rebased = rebaseDemoRun(demo, town);
            rebased.warnings = [
              `Live analysis failed (${message}). A bundled demo snapshot is shown instead.`,
              ...rebased.warnings,
            ];
            await replay(controller, rebased, signal);
          } else {
            // 4. Graceful partial failure.
            sse(controller, "error", {
              message: `Analysis failed and no bundled snapshot is available: ${message}`,
            });
          }
        }
      } catch (err) {
        sse(controller, "error", {
          message: err instanceof Error ? err.message : "Unexpected server error",
        });
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
