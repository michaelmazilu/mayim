import type { SimulationMetric } from "@/lib/types";

/** Linear-interpolation quantile on a sorted copy. Empty input gives 0. */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function summarise(values: number[]): SimulationMetric {
  return {
    p10: round1(quantile(values, 0.1)),
    p50: round1(quantile(values, 0.5)),
    p90: round1(quantile(values, 0.9)),
  };
}
