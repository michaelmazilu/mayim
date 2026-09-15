"use client";

import type { JSX } from "react";
import { motion } from "framer-motion";

/**
 * A 0..1 factor rendered as a hairline bar. The fill is ink rather than the
 * accent: this is a reading, and the accent means "this is actionable".
 *
 * `weight` is the 0..1 scoring weight, shown as a whole percentage; `delay`
 * staggers the fill so a column of them resolves top to bottom.
 */
export function ScoreBar(props: {
  label: string;
  value: number;
  weight?: number;
  delay?: number;
}): JSX.Element {
  const { label, value, weight, delay = 0 } = props;
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[13px] leading-tight">{label}</span>
        <span className="mono num shrink-0 text-[12px] text-[color:var(--text-muted)]">
          {clamped.toFixed(2)}
        </span>
      </div>

      <div className="mt-[6px] flex items-center gap-2">
        <div className="h-[4px] flex-1 overflow-hidden bg-[var(--bg-sunken)]">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${clamped * 100}%` }}
            transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
            className="h-full bg-[var(--text)]"
          />
        </div>
        {weight === undefined ? null : (
          <span className="mono num w-[30px] shrink-0 text-right text-[11px] text-[color:var(--text-subtle)]">
            {Math.round(weight * 100)}%
          </span>
        )}
      </div>
    </div>
  );
}
