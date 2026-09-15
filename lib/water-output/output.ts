/**
 * Water-output model.
 *
 * Turns site climate and groundwater evidence into a daily-yield range and the
 * population that range can support. Every rate, efficiency and per-capita
 * figure comes from `lib/config/coefficients.ts`; nothing is hardcoded and the
 * model is a pure function of its inputs.
 *
 * Every estimate reports the actual arithmetic in `formula` so a reviewer can
 * check the number rather than trust it.
 */

import type { InfrastructureType, WaterOutputEstimate } from "@/lib/types";
import { WATER } from "@/lib/config/coefficients";

export type OutputInput = {
  solarKwhM2Day: number;
  groundwaterConfidence: number;
  annualRainfallMm: number;
  /** catchment roof area for rainwater harvesting */
  roofAreaM2: number;
};

const DAYS_PER_YEAR = 365;
const MM_PER_M = 1000;
const LITERS_PER_M3 = 1000;

const INT_FMT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function qty(n: number): string {
  return INT_FMT.format(Math.round(n));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function positive(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Planning precision: daily volumes are reported to the nearest 10 litres. */
function round10(n: number): number {
  return Math.round(n / 10) * 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Peak-sun-hours converted into hours the system can actually run.
 * Also used as the daylight operating window for hand pumps, treatment skids
 * and tap stands, all of which are limited to daytime hours in practice.
 */
function effectiveHours(solarKwhM2Day: number): number {
  return round3(positive(solarKwhM2Day) * WATER.solarPumpingHoursFactor);
}

/**
 * The lower bound of a yield band is the benchmark minimum; the upper bound is
 * only credited in proportion to the groundwater evidence, so a weakly
 * evidenced site cannot claim the top of the published range.
 */
function evidenceScaledBand(
  band: { low: number; high: number },
  groundwaterConfidence: number,
): { low: number; high: number } {
  const confidence = clamp01(groundwaterConfidence);
  return { low: band.low, high: band.low + (band.high - band.low) * confidence };
}

type Draft = {
  pumpRateLitersPerHour: number;
  effectivePumpingHours: number;
  operationalEfficiency: number;
  dailyLitersLow: number;
  dailyLitersHigh: number;
  /** Built after the daily volumes are rounded, so the printed numbers match. */
  formula: (low: number, high: number) => string;
  caveats: string[];
};

function pumpedDraft(
  input: OutputInput,
  band: { low: number; high: number },
  rateBandSource: string,
  windowLabel: string,
  efficiency: number,
  efficiencyLabel: string,
  caveats: string[],
): Draft {
  const hours = effectiveHours(input.solarKwhM2Day);
  const rateLow = band.low;
  const rateHigh = band.high;
  return {
    pumpRateLitersPerHour: Math.round((rateLow + rateHigh) / 2),
    effectivePumpingHours: hours,
    operationalEfficiency: round3(efficiency),
    dailyLitersLow: rateLow * hours * efficiency,
    dailyLitersHigh: rateHigh * hours * efficiency,
    formula: (low, high) =>
      `${rateBandSource} ${qty(rateLow)}-${qty(rateHigh)} L/h x ${windowLabel} (${positive(input.solarKwhM2Day)} kWh/m2/day x ${WATER.solarPumpingHoursFactor} = ${hours} h) x ${efficiencyLabel} = ${qty(low)}-${qty(high)} L/day`,
    caveats,
  };
}

function draftFor(type: InfrastructureType, input: OutputInput): Draft {
  switch (type) {
    case "solar_borehole":
      return pumpedDraft(
        input,
        evidenceScaledBand(WATER.pumpRateLitersPerHour, input.groundwaterConfidence),
        "sustainable pump rate",
        "effective pumping hours",
        WATER.operationalEfficiency,
        `operational efficiency ${WATER.operationalEfficiency}`,
        [
          `Sustainable abstraction band is ${WATER.pumpRateLitersPerHour.low}-${WATER.pumpRateLitersPerHour.high} L/h (${WATER.pumpRateLitersPerHour.source}); the upper bound is credited only in proportion to the groundwater evidence score of ${clamp01(input.groundwaterConfidence).toFixed(2)}.`,
          "Output falls on overcast days and during array or pump downtime; storage sized upstream is what carries the community through those gaps.",
        ],
      );

    case "borehole_rehabilitation":
      return pumpedDraft(
        input,
        evidenceScaledBand(WATER.handPumpRateLitersPerHour, input.groundwaterConfidence),
        "hand-pump delivery rate",
        "daylight fetching window",
        WATER.operationalEfficiency,
        `operational efficiency ${WATER.operationalEfficiency}`,
        [
          `Priced and modelled as a hand-pump reinstatement (${WATER.handPumpRateLitersPerHour.low}-${WATER.handPumpRateLitersPerHour.high} L/h, ${WATER.handPumpRateLitersPerHour.source}). A motorised submersible upgrade would move yield toward the ${WATER.pumpRateLitersPerHour.low}-${WATER.pumpRateLitersPerHour.high} L/h band.`,
          "Hand-pump output is limited by queueing and by the hours people are willing to pump, which is why the daylight fetching window is used rather than a 24-hour day.",
          "The existing borehole may prove unrecoverable once surveyed, in which case this option disappears entirely.",
        ],
      );

    case "rainwater_harvesting": {
      const roof = positive(input.roofAreaM2);
      const rainfall = positive(input.annualRainfallMm);
      // Annual harvest spread evenly across the year, then discounted for losses.
      const gross =
        (roof * (rainfall / MM_PER_M) * WATER.runoffCoefficient * LITERS_PER_M3) / DAYS_PER_YEAR;
      return {
        pumpRateLitersPerHour: 0,
        effectivePumpingHours: 0,
        operationalEfficiency: round3(WATER.operationalEfficiency),
        dailyLitersLow: gross * WATER.operationalEfficiency,
        dailyLitersHigh: gross,
        formula: (low, high) =>
          `${qty(roof)} m2 x (${qty(rainfall)} mm / ${INT_FMT.format(MM_PER_M)}) x runoff coefficient ${WATER.runoffCoefficient} x ${INT_FMT.format(LITERS_PER_M3)} / ${DAYS_PER_YEAR} days = ${qty(gross)} L/day gross; low bound applies operational efficiency ${WATER.operationalEfficiency} = ${qty(low)}-${qty(high)} L/day`,
        caveats: [
          "This is an annual average. Rainwater supply is strongly seasonal: in the dry months the system delivers nothing and the community depends entirely on stored volume.",
          "Assumes the full roof area is guttered, in good condition, and made of a material suitable for potable collection.",
          "Gravity-fed system with no pump, so there is no pump rate to report.",
        ],
      };
    }

    case "filtration_and_storage": {
      // Two loss stages: abstraction/conveyance, then filter backwash and reject.
      const efficiency = WATER.operationalEfficiency * WATER.operationalEfficiency;
      return pumpedDraft(
        input,
        WATER.pumpRateLitersPerHour,
        "treatment throughput",
        "daily treatment window",
        efficiency,
        `combined efficiency (${WATER.operationalEfficiency} conveyance x ${WATER.operationalEfficiency} filter backwash and reject = ${round3(efficiency)})`,
        [
          "Throughput is limited by storage turnover: the volume that can pass through the treated-storage tank in a day is the treatment rate multiplied by the daily operating window, and the tank is sized upstream to hold that turnover.",
          "Assumes the raw source runs year-round at or above the treatment rate; a seasonal source caps output at whatever the source delivers.",
          "Filter media and chlorine must be resupplied continuously — output goes to zero when consumables run out, not gradually.",
        ],
      );
    }

    case "community_storage_and_taps":
      return pumpedDraft(
        input,
        WATER.pumpRateLitersPerHour,
        "bulk fill and dispensing rate",
        "daily dispensing window",
        WATER.operationalEfficiency,
        `operational efficiency ${WATER.operationalEfficiency}`,
        [
          "Throughput is storage-turnover limited: daily volume is the rate at which the tank is filled and drawn down multiplied by the daily dispensing window, with the tank sized upstream to hold that turnover.",
          "Output depends entirely on an off-site bulk supply (tanker or mains). Delivery reliability, not hydrology, is the binding constraint.",
          "Recurrent bulk-water cost is the dominant lifetime cost of this option and is not captured in the capital estimate.",
        ],
      );
  }
}

export function estimateOutput(
  type: InfrastructureType,
  input: OutputInput,
): WaterOutputEstimate {
  const draft = draftFor(type, input);

  const dailyLitersLow = round10(Math.max(0, draft.dailyLitersLow));
  const dailyLitersHigh = round10(Math.max(dailyLitersLow, draft.dailyLitersHigh));
  const litersPerPersonPerDay = WATER.litersPerPersonPerDay.value;

  return {
    pumpRateLitersPerHour: draft.pumpRateLitersPerHour,
    effectivePumpingHours: draft.effectivePumpingHours,
    operationalEfficiency: draft.operationalEfficiency,
    formula: draft.formula(dailyLitersLow, dailyLitersHigh),
    dailyLitersLow,
    dailyLitersHigh,
    litersPerPersonPerDay,
    peopleSupportedLow: Math.floor(dailyLitersLow / litersPerPersonPerDay),
    peopleSupportedHigh: Math.floor(dailyLitersHigh / litersPerPersonPerDay),
    caveats: [
      "Desk-study planning figures only. Borehole yield in particular is not guaranteed by a desk study: the sustainable rate must be confirmed by a step-drawdown and constant-rate pumping test on the completed borehole.",
      `People supported assumes ${litersPerPersonPerDay} L/person/day (${WATER.litersPerPersonPerDay.source}); real consumption varies with walking distance, queueing time and the alternatives available.`,
      "No allowance is made for livestock, irrigation, institutional or commercial demand, which routinely consume a large share of a rural water point's output.",
      ...draft.caveats,
    ],
  };
}
