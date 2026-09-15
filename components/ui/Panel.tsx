"use client";

import type { JSX, ReactNode } from "react";

/**
 * The shared panel shell. A hairline and nothing else — a shadow would be two
 * more edges stacked on the border that is already there, which is what makes a
 * set of panels read as embossed rather than as flat surfaces.
 */
export function Panel(props: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const { children, className = "" } = props;

  return <div className={`card overflow-hidden ${className}`}>{children}</div>;
}
