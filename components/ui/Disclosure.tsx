"use client";

import { useState, type JSX, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * A titled section that stays shut until asked. `hint` carries the one figure
 * worth seeing without opening it, so a closed row is still a reading rather
 * than just a lid.
 */
export function Disclosure(props: {
  label: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const { label, hint, defaultOpen = false, children } = props;
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-[color:var(--border-subtle)] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 py-2.5 text-left"
      >
        <span className="lbl min-w-0 flex-1">{label}</span>
        {hint ? (
          <span className="mono num shrink-0 text-[10.5px] text-[color:var(--text-muted)]">
            {hint}
          </span>
        ) : null}
        <span
          className={`shrink-0 text-[color:var(--grey-4)] transition-transform duration-200 ${
            open ? "rotate-90" : ""
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
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="pb-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
