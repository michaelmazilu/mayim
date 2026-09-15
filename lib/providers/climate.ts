import type { ClimateData, LngLat } from "@/lib/types";
import { CLIMATE_FALLBACK } from "@/lib/config/coefficients";
import { fetchJson } from "@/lib/providers/fetchWithTimeout";

/**
 * NASA POWER long-term climatology (no API key required).
 * PRECTOTCORR is mm/day. ALLSKY_SFC_SW_DWN is MJ/m2/day and MUST be divided by
 * MJ_PER_KWH to reach the kWh/m2/day figure the pumping model expects.
 */

const BASE = "https://power.larc.nasa.gov/api/temporal/climatology/point";
const TIMEOUT_MS = 15_000;
const SOURCE = "NASA POWER climatology (PRECTOTCORR, ALLSKY_SFC_SW_DWN)";
/** NASA POWER reports irradiance in MJ/m2/day; 1 kWh = 3.6 MJ. */
const MJ_PER_KWH = 3.6;

const DAYS_PER_YEAR = 365.25;
const DAYS_PER_MONTH = 30.4;
/** Below this monthly total a month counts as part of the dry season. */
const DRY_MONTH_MM = 30;

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

type PowerResponse = {
  properties?: {
    parameter?: Record<string, Record<string, number>>;
  };
  /** Per-parameter metadata, e.g. { ALLSKY_SFC_SW_DWN: { units: "MJ/m^2/day" } }. */
  parameters?: Record<string, { units?: string }>;
};

/** Surface shortwave irradiance cannot physically exceed this in kWh/m2/day. */
const MAX_SURFACE_KWH_M2_DAY = 12;

/**
 * ClimateData.solarKwhM2Day is kWh/m2/day. The response's own units block is the
 * authority; when it is absent, a value above the physical surface ceiling can
 * only be MJ/m2/day, so the same conversion applies.
 */
function toKwhM2Day(value: number, units: string | undefined): number {
  if (units) return units.toUpperCase().includes("MJ") ? value / MJ_PER_KWH : value;
  return value > MAX_SURFACE_KWH_M2_DAY ? value / MJ_PER_KWH : value;
}

/** NASA POWER uses -999 as its fill value. */
function valid(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > -900;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function countDryMonths(monthlyMmDay: number[]): number {
  let dry = 0;
  for (const mmDay of monthlyMmDay) {
    if (mmDay * DAYS_PER_MONTH < DRY_MONTH_MM) dry += 1;
  }
  return dry;
}

function fallbackClimate(): ClimateData {
  // No monthly shape is known, so the annual total is spread evenly across the year.
  const flatMmDay = round(CLIMATE_FALLBACK.annualRainfallMm / DAYS_PER_YEAR, 3);
  const monthly = MONTHS.map(() => flatMmDay);
  return {
    annualRainfallMm: CLIMATE_FALLBACK.annualRainfallMm,
    monthlyRainfallMmDay: monthly,
    solarKwhM2Day: CLIMATE_FALLBACK.solarKwhM2Day,
    drySeasonMonths: countDryMonths(monthly),
    source: CLIMATE_FALLBACK.source,
    estimated: true,
  };
}

export async function fetchClimate(center: LngLat): Promise<ClimateData> {
  try {
    // Coordinates are rounded so the same town always produces the same request URL.
    const lon = round(center[0], 4);
    const lat = round(center[1], 4);
    const url =
      `${BASE}?parameters=PRECTOTCORR,ALLSKY_SFC_SW_DWN&community=AG` +
      `&longitude=${lon}&latitude=${lat}&format=JSON`;

    const json = await fetchJson<PowerResponse>(
      url,
      { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" },
      TIMEOUT_MS,
    );

    const parameters = json?.properties?.parameter;
    const rain = parameters?.["PRECTOTCORR"];
    const solar = parameters?.["ALLSKY_SFC_SW_DWN"];
    if (!rain && !solar) return fallbackClimate();

    let estimated = false;

    // --- rainfall -----------------------------------------------------------
    const rawMonthly = MONTHS.map((m) => (rain ? rain[m] : undefined));
    const validMonthly = rawMonthly.filter(valid);
    const annRaw = rain ? rain["ANN"] : undefined;
    const monthlyMean = mean(validMonthly);

    if (validMonthly.length < MONTHS.length) estimated = true;

    // Any missing month is filled with the annual daily mean so the series stays 12 long.
    const fillMmDay = valid(annRaw) ? annRaw : (monthlyMean ?? CLIMATE_FALLBACK.annualRainfallMm / DAYS_PER_YEAR);
    const monthlyRainfallMmDay = rawMonthly.map((v) => round(valid(v) ? v : fillMmDay, 3));

    let annualRainfallMm: number;
    if (valid(annRaw)) {
      annualRainfallMm = round(annRaw * DAYS_PER_YEAR, 1);
    } else if (monthlyMean !== null) {
      annualRainfallMm = round(monthlyMean * DAYS_PER_YEAR, 1);
      estimated = true;
    } else {
      annualRainfallMm = CLIMATE_FALLBACK.annualRainfallMm;
      estimated = true;
    }

    // --- solar --------------------------------------------------------------
    const solarUnits = json?.parameters?.["ALLSKY_SFC_SW_DWN"]?.units;
    const solarAnn = solar ? solar["ANN"] : undefined;
    const solarMonthlyMean = mean(MONTHS.map((m) => (solar ? solar[m] : undefined)).filter(valid));
    let solarKwhM2Day: number;
    if (valid(solarAnn)) {
      solarKwhM2Day = round(toKwhM2Day(solarAnn, solarUnits), 3);
    } else if (solarMonthlyMean !== null) {
      solarKwhM2Day = round(toKwhM2Day(solarMonthlyMean, solarUnits), 3);
      estimated = true;
    } else {
      solarKwhM2Day = CLIMATE_FALLBACK.solarKwhM2Day;
      estimated = true;
    }

    return {
      annualRainfallMm,
      monthlyRainfallMmDay,
      solarKwhM2Day,
      drySeasonMonths: countDryMonths(monthlyRainfallMmDay),
      source: estimated ? `${SOURCE} — partially filled from fallback assumptions` : SOURCE,
      estimated,
    };
  } catch {
    return fallbackClimate();
  }
}
