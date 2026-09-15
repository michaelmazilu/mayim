/**
 * Simulation rates from the sourced behaviour table (lib/config/behaviour.ts).
 *
 * Existing points are community-managed: their country's measured share out of
 * service and community repair times. The new system is assumed to come with
 * professional maintenance (FundiFix, Whave: repairs within days), so it breaks
 * down as often as community-managed schemes of the same hardware but is back
 * within the week. The community-managed alternative is simulated too, so the
 * value of the maintenance contract is a number, not a claim.
 */
import type { InfrastructureType, SimulationRates, TownRef } from "@/lib/types";
import {
  growthRateForTown,
  meanDaysBetweenBreakdowns,
  MOTORISED_SCHEME_DOWN_SHARE,
  REPAIR_DAYS,
  WATER_POINT_DOWN_SHARE,
  WATER_POINT_DOWN_SHARE_BY_COUNTRY,
} from "@/lib/config/behaviour";
import { countryIso2 } from "@/lib/geo/countries";

export type HardwareClass = "handpump" | "motorised";

export const HARDWARE: Record<InfrastructureType, HardwareClass> = {
  solar_borehole: "motorised",
  community_storage_and_taps: "motorised",
  filtration_and_storage: "motorised",
  borehole_rehabilitation: "handpump",
  rainwater_harvesting: "handpump",
};

/** Mean days between breakdowns by hardware, from community-managed availability and repair time. */
export const MTBF_DAYS: Record<HardwareClass, number> = {
  handpump: meanDaysBetweenBreakdowns(WATER_POINT_DOWN_SHARE.central, REPAIR_DAYS.communityManaged.central),
  motorised: meanDaysBetweenBreakdowns(MOTORISED_SCHEME_DOWN_SHARE.central, REPAIR_DAYS.motorisedCommunityManaged.central),
};

const weeklyFailure = (mtbfDays: number) => 1 - Math.exp(-7 / Math.max(1, mtbfDays));
const band = (days: number): [number, number] => {
  const w = days / 7;
  return [Math.max(1, Math.round(w * 0.5)), Math.max(1, Math.round(w * 1.5))];
};

export function sourcedRates(town: TownRef): { rates: SimulationRates; notes: string[] } {
  const iso = countryIso2(town.country);
  const byCountry = iso ? WATER_POINT_DOWN_SHARE_BY_COUNTRY[iso as keyof typeof WATER_POINT_DOWN_SHARE_BY_COUNTRY] : undefined;
  const down = byCountry ?? WATER_POINT_DOWN_SHARE;
  const repair = REPAIR_DAYS.communityManaged;
  const growth = growthRateForTown(town.slug, iso);
  const [repairLow, repairHigh] = band(repair.central);
  const professional = REPAIR_DAYS.professionalService;
  const rates: SimulationRates = {
    failExisting: weeklyFailure(meanDaysBetweenBreakdowns(down.central, repair.central)),
    failProject: weeklyFailure(MTBF_DAYS.motorised),
    shareExisting: down.central,
    repairLow,
    repairHigh,
    projectRepairLow: 1,
    projectRepairHigh: Math.max(1, Math.ceil(professional.high / 7)),
    growth: growth.central / 100,
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return {
    rates,
    notes: [
      `Existing points are out of service ${pct(down.central)} of the time (${down.source}) and take ${repairLow}-${repairHigh} weeks to repair (${repair.source}).`,
      `The new system breaks down as often as community-managed schemes of its type (motorised: every ${Math.round(MTBF_DAYS.motorised)} days; handpump: every ${Math.round(MTBF_DAYS.handpump)} days), but with professional maintenance it is back within the week (${professional.source}).`,
      `Households grow ${growth.central.toFixed(1)}% a year (${growth.source}).`,
    ],
  };
}

/** The same rates, with the project's breakdown frequency set by its hardware. */
export function ratesForType(base: SimulationRates, type: InfrastructureType): SimulationRates {
  return { ...base, failProject: weeklyFailure(MTBF_DAYS[HARDWARE[type]]) };
}

/** The project's rates if it were community-managed instead: same breakdowns, community repair times. */
export function communityManaged(rates: SimulationRates, type: InfrastructureType): SimulationRates {
  const days = HARDWARE[type] === "motorised" ? REPAIR_DAYS.motorisedCommunityManaged.central : REPAIR_DAYS.communityManaged.central;
  const [lo, hi] = band(days);
  return { ...rates, projectRepairLow: lo, projectRepairHigh: hi };
}
