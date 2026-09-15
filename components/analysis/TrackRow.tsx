"use client";

import type { JSX } from "react";
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { AnalysisEvent, TrackId, TrackStatus } from "@/lib/types";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function sourceLabel(n: number): string {
  return n === 1 ? "1 source" : `${n} sources`;
}

function StatusMark({ status }: { status: TrackStatus }): JSX.Element {
  if (status === "complete") {
    return (
      <span className="grid h-[14px] w-[14px] place-items-center bg-[var(--st-ok)] text-white">
        <svg viewBox="0 0 12 12" className="h-[8px] w-[8px]" aria-hidden="true">
          <path
            d="M1.7 6.3 4.5 9.1 10.3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (status === "degraded") {
    return (
      <span className="grid h-[14px] w-[14px] place-items-center bg-[var(--st-warn)] text-white">
        <svg viewBox="0 0 12 12" className="h-[8px] w-[8px]" aria-hidden="true">
          <path d="M6 2.4v4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="6" cy="9.2" r="0.85" fill="currentColor" />
        </svg>
      </span>
    );
  }

  if (status === "active") {
    return (
      <span className="grid h-[14px] w-[14px] place-items-center">
        <motion.span
          className="h-[8px] w-[8px] bg-[var(--st-live)]"
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
        />
      </span>
    );
  }

  /* Dormant: an outline, because nothing has happened yet and a fill would say
     it had. */
  return (
    <span className="grid h-[14px] w-[14px] place-items-center">
      <span className="h-[8px] w-[8px] border border-[color:var(--grey-4)]" />
    </span>
  );
}

/** The per-event lamp in the expanded timeline, one hue per state. */
const DOT_COLOR: Record<TrackStatus, string> = {
  pending: "bg-[var(--grey-4)]",
  active: "bg-[var(--st-live)]",
  complete: "bg-[var(--st-ok)]",
  degraded: "bg-[var(--st-warn)]",
};

export function TrackRow(props: {
  trackId: TrackId;
  label: string;
  events: AnalysisEvent[];
  index: number;
}): JSX.Element {
  const { trackId, label, events, index } = props;
  const [expanded, setExpanded] = useState(false);

  // Oldest-first, and defensive against a caller passing the unfiltered feed.
  const ordered = useMemo(
    () => events.filter((e) => e.track === trackId).sort((a, b) => a.ts - b.ts),
    [events, trackId],
  );

  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null;
  const status: TrackStatus = latest ? latest.status : "pending";

  return (
    <motion.div
      data-track={trackId}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE, delay: Math.min(index, 8) * 0.035 }}
      className="border-b border-[color:var(--border-subtle)] last:border-b-0"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[var(--bg-sunken)]"
      >
        <span className="mt-[2px] shrink-0">
          <StatusMark status={status} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate text-[13px] leading-tight ${
                status === "pending" ? "text-[color:var(--text-subtle)]" : ""
              }`}
            >
              {label}
            </span>
            {latest && (
              <span className="mono num shrink-0 text-[11px] text-[color:var(--text-subtle)]">
                {clockTime(latest.ts)}
              </span>
            )}
          </span>

          <span className="mt-0.5 block min-h-[16px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={latest ? latest.id : "pending"}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.16, ease: EASE }}
                className="sm muted block leading-snug"
              >
                {latest ? latest.message : "Awaiting analysis"}
              </motion.span>
            </AnimatePresence>
          </span>

          {latest && typeof latest.sourceCount === "number" && (
            <span className="ch-pill plain mt-1.5">{sourceLabel(latest.sourceCount)}</span>
          )}
        </span>

        <span
          className={`mt-[3px] shrink-0 text-[color:var(--grey-4)] transition-transform duration-200 ${
            expanded ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 10 10" className="h-[9px] w-[9px]">
            <path
              d="M3.4 1.6 6.9 5 3.4 8.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 pl-[42px]">
              {ordered.length === 0 ? (
                <p className="sm muted">No activity recorded yet.</p>
              ) : (
                <ol className="relative border-l border-[color:var(--border)] pl-3">
                  {ordered.map((event) => (
                    <motion.li
                      key={event.id}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, ease: EASE }}
                      className="relative py-[4px]"
                    >
                      <span
                        className={`absolute -left-[15px] top-[10px] h-[5px] w-[5px] ${
                          DOT_COLOR[event.status]
                        }`}
                      />
                      <span className="flex items-baseline gap-2">
                        <span className="mono num shrink-0 text-[10px] text-[color:var(--text-subtle)]">
                          {clockTime(event.ts)}
                        </span>
                        {typeof event.sourceCount === "number" && (
                          <span className="mono shrink-0 text-[10px] text-[color:var(--text-subtle)]">
                            {sourceLabel(event.sourceCount)}
                          </span>
                        )}
                      </span>
                      <span className="sm muted mt-[1px] block leading-snug">{event.message}</span>
                    </motion.li>
                  ))}
                </ol>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
