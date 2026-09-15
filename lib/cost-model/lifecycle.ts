/**
 * Whole-life cost: capital plus running costs over the planning horizon.
 * Undiscounted, because the comparison is between options over the same
 * horizon and a discount rate would be one more assumption to defend.
 */
import type { InfrastructureType } from "@/lib/types";
import { LIFECYCLE, WATER } from "@/lib/config/coefficients";

export function lifecycleCost(
  type: InfrastructureType,
  capitalMid: number,
  deliveredLitresPerDay: number,
  years: number,
): { total: number; omPerYear: number; variablePerYear: number } {
  const omPerYear = Math.max(0, capitalMid) * LIFECYCLE.annualOmShare[type];
  const m3PerYear = (Math.max(0, deliveredLitresPerDay) * 365) / 1000;
  const variablePerYear = m3PerYear * LIFECYCLE.perM3Delivered[type];
  return {
    total: Math.round(capitalMid + years * (omPerYear + variablePerYear)),
    omPerYear: Math.round(omPerYear),
    variablePerYear: Math.round(variablePerYear),
  };
}

/** Litres per person per day, re-exported so callers price the same demand the model serves. */
export const LITRES_PER_PERSON_PER_DAY = WATER.litersPerPersonPerDay.value;
