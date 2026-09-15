/**
 * Capital cost per person served — the headline efficiency figure.
 *
 * The range is deliberately the widest honest one: cheapest build over the
 * most people, to dearest build over the fewest. Capital cost only; operation
 * and maintenance are excluded and the basis string says so.
 */

import type { InfrastructureRecommendation } from "@/lib/types";

export type CostPerPerson = {
  /** USD per person, rounded to $1. */
  low: number;
  mid: number;
  high: number;
  basis: string;
};

export function costPerPersonServed(rec: InfrastructureRecommendation | null | undefined): CostPerPerson | null {
  if (!rec) return null;
  const { totalLow, totalHigh } = rec.cost;
  const { peopleServedLow, peopleServedHigh } = rec;
  if (!(peopleServedLow > 0) || !(peopleServedHigh > 0) || !(totalLow > 0) || !(totalHigh > 0)) return null;

  const low = Math.round(totalLow / peopleServedHigh);
  const high = Math.round(totalHigh / peopleServedLow);
  const mid = Math.round((totalLow + totalHigh) / (peopleServedLow + peopleServedHigh));
  return {
    low,
    mid,
    high,
    basis:
      `Capital cost $${totalLow.toLocaleString("en-US")}–$${totalHigh.toLocaleString("en-US")} ÷ ` +
      `${peopleServedLow.toLocaleString("en-US")}–${peopleServedHigh.toLocaleString("en-US")} people served. ` +
      "Excludes operation and maintenance.",
  };
}
