"use client";

import type { JSX } from "react";

/**
 * One tile of the KPI mosaic. Label at the top, figure pinned to the bottom, so
 * the numbers sit on one line across a row no matter how many lines a label
 * wraps to. `value` is pre-formatted by the caller.
 *
 * Tone is the only emphasis available: a tile is the base grey unless it holds
 * the figure the reader is meant to find first, and then it is one step darker.
 * Deliberately not the accent — accent means "this is actionable", and every
 * figure on this screen is a reading.
 */
export function Stat(props: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}): JSX.Element {
  const { label, value, sub, accent = false } = props;

  return (
    <div className={`kpi ${accent ? "tone-2" : ""}`}>
      <div className="l">{label}</div>
      <div>
        <div className="v text-[19px]">{value}</div>
        {sub ? <div className="d">{sub}</div> : null}
      </div>
    </div>
  );
}
