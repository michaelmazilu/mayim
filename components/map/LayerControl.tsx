"use client";

import type { JSX } from "react";
import { motion } from "framer-motion";
import { LAYER_META, type LayerId } from "./layers";

/**
 * Layer toggles. A checkbox column rather than a row of switches: these are
 * seven readings of one set, and a set is read down a column at one size.
 * Positioning is left to the parent so the panel can be anchored wherever the
 * map shell needs it.
 */
export function LayerControl(props: {
  layers: Record<LayerId, boolean>;
  onToggle: (id: LayerId) => void;
  /** Toggles with nothing behind them for this run, e.g. a simulation that was not produced. */
  hidden?: LayerId[];
}): JSX.Element {
  const { layers, onToggle, hidden = [] } = props;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="card w-[178px] shadow-[var(--shadow-2)]"
    >
      <div className="border-b border-[color:var(--border-subtle)] px-3 py-2">
        <span className="lbl">Layers</span>
      </div>

      <div className="py-1">
        {LAYER_META.filter((meta) => !hidden.includes(meta.id)).map((meta) => {
          const on = layers[meta.id];
          return (
            <button
              key={meta.id}
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={meta.label}
              onClick={() => onToggle(meta.id)}
              className="flex w-full items-center gap-2.5 px-3 py-[5px] text-left transition-colors duration-100 hover:bg-[var(--bg-sunken)]"
            >
              {/* Filled ink when on, an outline when off. Fill vs. outline is
                  the whole signal; no hue is spent here. */}
              <span
                className={`grid h-[13px] w-[13px] shrink-0 place-items-center border transition-colors duration-100 ${
                  on
                    ? "border-[color:var(--text)] bg-[var(--text)] text-[var(--paper)]"
                    : "border-[color:var(--grey-4)]"
                }`}
              >
                {on ? (
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
                ) : null}
              </span>

              <span
                className={`text-[12px] leading-none ${
                  on ? "" : "text-[color:var(--text-muted)]"
                }`}
              >
                {meta.label}
              </span>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}
