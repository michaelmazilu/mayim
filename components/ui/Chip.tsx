"use client";

import type { JSX, ReactNode } from "react";

/**
 * `neutral` and `accent` are readings; `warn` and `good` are states. States get
 * the lamp, readings do not — the dot means "this is true right now", and a
 * label that is merely metadata is not that.
 */
export type ChipTone = "neutral" | "accent" | "warn" | "good";

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: "tag muted",
  accent: "tag accent",
  warn: "ch-pill warn",
  good: "ch-pill ok",
};

/** Small badge used for status and metadata. */
export function Chip(props: {
  children: ReactNode;
  tone?: ChipTone;
  className?: string;
}): JSX.Element {
  const { children, tone = "neutral", className = "" } = props;

  return <span className={`${TONE_CLASS[tone]} ${className}`}>{children}</span>;
}
