"use client";

import { useMemo, useRef, type JSX, type KeyboardEvent, type PointerEvent } from "react";
import { WEEKS_PER_YEAR } from "@/lib/popsim/engine";
import type { PlaybackTrace } from "./types";

/**
 * Ten years on one hairline. From the top: people served per week (solid to
 * the playhead, a ghost beyond it once a future has been seen), the design
 * level as a dotted rule, the track with its progress fill and one tick per
 * year, and a red mark under every week the new system was out of service.
 *
 * Drawn in week units with a non-uniform viewBox, so the geometry is just the
 * data; strokes are non-scaling so every line stays one pixel wide.
 */

const VB_H = 26;
const SPARK_TOP = 2;
const SPARK_BOTTOM = 15;
const TRACK_Y = 18.5;
const TICK_TOP = 16.5;
const TICK_BOTTOM = 20.5;
const DOWN_Y = 23.5;

type Run = { start: number; end: number };

function downRuns(down: number[]): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let w = 0; w <= down.length; w++) {
    const isDown = w < down.length && down[w] === 1;
    if (isDown && start < 0) start = w;
    if (!isDown && start >= 0) {
      runs.push({ start, end: w });
      start = -1;
    }
  }
  return runs;
}

function linePath(served: number[], from: number, to: number, y: (v: number) => number): string {
  if (to - from < 1) return "";
  let d = "";
  for (let w = from; w < to; w++) {
    d += `${w === from ? "M" : "L"}${(w + 0.5).toFixed(1)},${y(served[w]).toFixed(2)}`;
  }
  return d;
}

export function Scrubber(props: {
  weeks: number;
  elapsed: number;
  designed: number;
  trace: PlaybackTrace;
  valueText: string;
  onSeek: (elapsed: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
}): JSX.Element {
  const { weeks, elapsed, designed, trace, valueText, onSeek, onScrubStart, onScrubEnd } = props;
  const dragging = useRef(false);
  const pending = useRef<number | null>(null);
  const frame = useRef(0);

  const geometry = useMemo(() => {
    const known = trace.served.length;
    let peak = designed > 0 ? designed : 1;
    for (let w = 0; w < known; w++) if (trace.served[w] > peak) peak = trace.served[w];
    const top = peak * 1.08;
    const y = (v: number): number => SPARK_BOTTOM - (Math.max(0, v) / top) * (SPARK_BOTTOM - SPARK_TOP);
    const cut = Math.min(known, Math.max(0, elapsed));
    const past = linePath(trace.served, 0, cut, y);
    // Start the ghost one week back so the two halves join.
    const ghost = cut < known ? linePath(trace.served, Math.max(0, cut - 1), known, y) : "";
    const area = past ? `${past}L${(cut - 0.5).toFixed(1)},${SPARK_BOTTOM}L0.5,${SPARK_BOTTOM}Z` : "";
    return {
      past,
      ghost,
      area,
      designY: designed > 0 ? y(designed) : null,
      runs: downRuns(trace.down),
    };
  }, [trace, elapsed, designed]);

  const years = Math.max(1, Math.round(weeks / WEEKS_PER_YEAR));
  const ticks = Array.from({ length: years + 1 }, (_, i) => Math.min(weeks, i * WEEKS_PER_YEAR));
  const progress = weeks > 0 ? Math.min(1, Math.max(0, elapsed / weeks)) : 0;

  const weekAt = (clientX: number, element: HTMLElement): number => {
    const rect = element.getBoundingClientRect();
    const f = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.min(weeks, Math.max(1, Math.round(f * weeks)));
  };

  // Seeks are coalesced to one per animation frame: a drag can report pointer
  // moves faster than the display refreshes.
  const queueSeek = (target: number): void => {
    pending.current = target;
    if (frame.current) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0;
      const next = pending.current;
      pending.current = null;
      if (next !== null) onSeek(next);
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    onScrubStart();
    queueSeek(weekAt(event.clientX, event.currentTarget));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    queueSeek(weekAt(event.clientX, event.currentTarget));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onScrubEnd();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 13 : 1;
    let target: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") target = elapsed + step;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") target = elapsed - step;
    else if (event.key === "PageUp") target = elapsed + WEEKS_PER_YEAR;
    else if (event.key === "PageDown") target = elapsed - WEEKS_PER_YEAR;
    else if (event.key === "Home") target = 1;
    else if (event.key === "End") target = weeks;
    if (target === null) return;
    event.preventDefault();
    onSeek(Math.min(weeks, Math.max(1, target)));
  };

  return (
    <div
      className="simbar-scrub"
      role="slider"
      tabIndex={0}
      aria-label="Simulated time"
      aria-valuemin={1}
      aria-valuemax={weeks}
      aria-valuenow={elapsed}
      aria-valuetext={valueText}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <svg viewBox={`0 0 ${weeks} ${VB_H}`} preserveAspectRatio="none" aria-hidden="true">
        {geometry.area ? <path d={geometry.area} className="simbar-spark-area" /> : null}
        {geometry.designY !== null ? (
          <line x1={0} x2={weeks} y1={geometry.designY} y2={geometry.designY} className="simbar-design" />
        ) : null}
        {geometry.ghost ? <path d={geometry.ghost} className="simbar-spark-ghost" /> : null}
        {geometry.past ? <path d={geometry.past} className="simbar-spark" /> : null}

        <line x1={0} x2={weeks} y1={TRACK_Y} y2={TRACK_Y} className="simbar-track" />
        <line x1={0} x2={elapsed} y1={TRACK_Y} y2={TRACK_Y} className="simbar-fill" />
        {ticks.map((x) => (
          <line key={x} x1={x} x2={x} y1={TICK_TOP} y2={TICK_BOTTOM} className="simbar-tick" />
        ))}

        {geometry.runs.map((run) => (
          <line
            key={run.start}
            x1={run.start + 0.5}
            x2={run.end - 0.5}
            y1={DOWN_Y}
            y2={DOWN_Y}
            className={`simbar-down ${run.start >= elapsed ? "ahead" : ""}`}
          />
        ))}
      </svg>

      {/* The playhead is HTML so its knob stays square in a stretched viewBox. */}
      <span className="simbar-head" style={{ left: `${progress * 100}%` }} aria-hidden="true" />
    </div>
  );
}
