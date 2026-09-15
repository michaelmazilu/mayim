"use client";

import type { JSX } from "react";

export const DISCLAIMER_TEXT =
  "For pre-feasibility analysis; field surveys and licensed engineering remain required.";

/** Standing caveat shown wherever an estimate is presented. */
export function Disclaimer(props: { className?: string }): JSX.Element {
  const { className = "" } = props;

  return (
    <p className={`sm muted leading-snug ${className}`}>{DISCLAIMER_TEXT}</p>
  );
}
