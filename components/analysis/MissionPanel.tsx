"use client";

import type { JSX } from "react";
import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { AnalysisEvent, LngLat, TownRef, TrackId, TrackStatus } from "@/lib/types";
import { TRACKS } from "@/lib/types";
import { TrackRow } from "./TrackRow";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const PROVENANCE_LABEL: Record<"live" | "cache" | "demo", string> = {
  live: "Live research",
  cache: "Saved analysis replayed",
  demo: "Bundled demo snapshot",
};

function formatCoords(center: LngLat): string {
  const [lon, lat] = center;
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}°${
    lon >= 0 ? "E" : "W"
  }`;
}

function subtitle(town: TownRef): string {
  const parts = [town.region, town.country].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(", ") : town.displayName;
}

export function MissionPanel(props: {
  town: TownRef;
  events: AnalysisEvent[];
  running: boolean;
  provenance: "live" | "cache" | "demo" | null;
  onRerun: () => void;
}): JSX.Element {
  const { town, events, running, provenance, onRerun } = props;

  const scrollRef = useRef<HTMLDivElement>(null);

  const byTrack = useMemo(() => {
    const map = new Map<TrackId, AnalysisEvent[]>();
    for (const track of TRACKS) map.set(track.id, []);
    for (const event of events) map.get(event.track)?.push(event);
    return map;
  }, [events]);

  /** The most recent event overall — drives the auto-scroll target. */
  const newest = useMemo(() => {
    let best: AnalysisEvent | null = null;
    for (const event of events) if (!best || event.ts >= best.ts) best = event;
    return best;
  }, [events]);

  const settledCount = useMemo(() => {
    let n = 0;
    for (const track of TRACKS) {
      const list = byTrack.get(track.id) ?? [];
      if (list.length === 0) continue;
      const status: TrackStatus = list.reduce((a, b) => (b.ts >= a.ts ? b : a)).status;
      if (status === "complete" || status === "degraded") n += 1;
    }
    return n;
  }, [byTrack]);

  useEffect(() => {
    if (!running || !newest) return;
    const container = scrollRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(`[data-track="${newest.track}"]`);
    if (!row) return;
    const top =
      row.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      12;
    container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [newest, running]);

  return (
    <aside className="flex h-full flex-col">
      <header className="shrink-0 border-b border-[color:var(--border-subtle)] px-4 py-3">
        <h2 className="truncate text-[16px] font-[400] leading-tight">{town.name}</h2>
        <p className="sm muted mt-0.5 truncate">{subtitle(town)}</p>
        <p className="mono num mt-1.5 text-[11px] text-[color:var(--text-subtle)]">
          {formatCoords(town.center)}
        </p>
      </header>

      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-3">
        <span className="lbl">Live analysis</span>
        <span className="mono num text-[11px] text-[color:var(--text-subtle)]">
          {settledCount}/{TRACKS.length}
        </span>
      </div>

      {/* The progress rule, and only while something is actually running. */}
      <div className="mx-4 mb-2 h-[2px] shrink-0 overflow-hidden bg-[var(--bg-sunken)]">
        {running ? (
          <motion.div
            className="h-full w-1/3 bg-[var(--accent)]"
            initial={{ x: "-100%" }}
            animate={{ x: "300%" }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : (
          <div
            className="h-full bg-[var(--text)] transition-[width] duration-500"
            style={{ width: `${(settledCount / TRACKS.length) * 100}%` }}
          />
        )}
      </div>

      <div ref={scrollRef} className="panel-scroll relative min-h-0 flex-1">
        {TRACKS.map((track, i) => (
          <TrackRow
            key={track.id}
            trackId={track.id}
            label={track.label}
            events={byTrack.get(track.id) ?? []}
            index={i}
          />
        ))}
      </div>

      <AnimatePresence initial={false}>
        {!running && (
          <motion.footer
            key="footer"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="shrink-0 overflow-hidden border-t border-[color:var(--border-subtle)]"
          >
            <div className="px-4 py-3">
              {provenance && (
                <div className="mb-2.5">
                  <span className={`ch-pill ${provenance === "live" ? "ok" : "idle"}`}>
                    {PROVENANCE_LABEL[provenance]}
                  </span>
                </div>
              )}
              <button type="button" onClick={onRerun} className="btn-ghost h-[30px] w-full">
                Re-run live research
              </button>
            </div>
          </motion.footer>
        )}
      </AnimatePresence>
    </aside>
  );
}
