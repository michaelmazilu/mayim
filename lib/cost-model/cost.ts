/**
 * Parametric capital-cost model.
 *
 * Every money figure is a range built from a coefficient in
 * `lib/config/coefficients.ts` multiplied by a quantity supplied by the caller.
 * Nothing here invents a price, and no result is hardcoded: the same inputs
 * always produce the same estimate.
 *
 * The output is a pre-feasibility planning range, which is why totals are
 * rounded outward to the nearest $1,000 — a figure like "$87,431" would imply
 * precision a desk study cannot deliver.
 */

import type { CostEstimate, CostLineItem, InfrastructureType } from "@/lib/types";
import type { Coefficient } from "@/lib/config/coefficients";
import { COST, DRILLING_DEPTH_M, SERVICE } from "@/lib/config/coefficients";

export type CostInput = {
  groundwaterConfidence: number; // 0..1 -> picks DRILLING_DEPTH_M band
  distanceToRoadM: number;
  slopeProxy: number;
  peopleServed: number;
  /** metres of conceptual distribution pipe, from the geospatial layout */
  pipelineLengthM: number;
  tapStandCount: number;
  solarArrayWp: number;
  tankVolumeLiters: number;
};

// ---------------------------------------------------------------------------
// Non-monetary shape parameters
//
// These are dimensionless model shape/sizing conventions, not prices or yields;
// every price and yield comes from lib/config/coefficients.ts.
// ---------------------------------------------------------------------------

/** Terrain/haulage surcharge shape. Caps at 1 + 0.25 + 0.10 = 1.35. */
const ACCESS = {
  /** At or below this road distance the site is treated as roadside. */
  roadsideThresholdM: 100,
  /** Surcharge at SERVICE.maxRoadDistanceM. */
  maxDistanceSurcharge: 0.25,
  /** Additional surcharge on the steepest terrain (slopeProxy = 1). */
  maxSlopeSurcharge: 0.1,
} as const;

/** Groundwater-evidence cut-offs that pick the DRILLING_DEPTH_M band. */
const DEPTH_BAND_THRESHOLDS = { favourable: 0.6, moderate: 0.35 } as const;

/**
 * Rainwater catchment sizing convention: 100 L of storage per m2 of roof.
 * The cost model only receives the tank volume, so the catchment area it prices
 * is the inverse of this rule. Kept deliberately in sync with the identically
 * named constant in lib/infrastructure/select.ts, which sizes the pair.
 */
const STORAGE_LITERS_PER_CATCHMENT_M2 = 100;

// ---------------------------------------------------------------------------
// Formatting helpers (explicit locale keeps output deterministic)
// ---------------------------------------------------------------------------

const INT_FMT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DEC_FMT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function qty(n: number): string {
  return INT_FMT.format(Math.round(n));
}

/** Sub-$10 unit rates keep cents ("$1.60-2.90"); larger ones do not ("$110-190"). */
function moneyRange(low: number, high: number): string {
  const fmt = (v: number): string => (v < 10 ? DEC_FMT.format(v) : INT_FMT.format(v));
  return `$${fmt(low)}-${fmt(high)}`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "USD/m" -> "/m", "USD/m2" -> "/m2", "USD" -> "". */
function perUnitSuffix(unit: string): string {
  return unit.startsWith("USD/") ? `/${unit.slice(4)}` : "";
}

// ---------------------------------------------------------------------------
// Line-item builders
// ---------------------------------------------------------------------------

function lumpItem(label: string, c: Coefficient): CostLineItem {
  return {
    label,
    formula: `Lump sum ${moneyRange(c.low, c.high)}`,
    low: Math.round(c.low),
    high: Math.round(c.high),
    source: c.source,
  };
}

/** quantity x unit-rate band, e.g. "620 m x $22-48/m" or "4 x $900-1,800 each". */
function perUnitItem(
  label: string,
  quantity: number,
  quantityUnit: string,
  c: Coefficient,
): CostLineItem {
  const range = moneyRange(c.low, c.high);
  const formula =
    c.unit === "USD each"
      ? `${qty(quantity)} x ${range} each`
      : `${qty(quantity)}${quantityUnit ? ` ${quantityUnit}` : ""} x ${range}${perUnitSuffix(c.unit)}`;
  return {
    label,
    formula,
    low: Math.round(quantity * c.low),
    high: Math.round(quantity * c.high),
    source: c.source,
  };
}

/** Band quantity x unit-rate band, e.g. "40-70 m x $110-190/m". */
function bandItem(
  label: string,
  quantityLow: number,
  quantityHigh: number,
  quantityUnit: string,
  c: Coefficient,
  extraSource: string,
): CostLineItem {
  return {
    label,
    formula: `${qty(quantityLow)}-${qty(quantityHigh)} ${quantityUnit} x ${moneyRange(c.low, c.high)}${perUnitSuffix(c.unit)}`,
    low: Math.round(quantityLow * c.low),
    high: Math.round(quantityHigh * c.high),
    source: `${c.source}; depth band: ${extraSource}`,
  };
}

// ---------------------------------------------------------------------------
// Drilling depth band
// ---------------------------------------------------------------------------

type DepthBandKey = keyof typeof DRILLING_DEPTH_M;
type DepthBand = { key: DepthBandKey; low: number; high: number; source: string };

function depthBand(groundwaterConfidence: number): DepthBand {
  const c = clamp01(groundwaterConfidence);
  if (c >= DEPTH_BAND_THRESHOLDS.favourable) {
    return { key: "favourable", ...DRILLING_DEPTH_M.favourable };
  }
  if (c >= DEPTH_BAND_THRESHOLDS.moderate) {
    return { key: "moderate", ...DRILLING_DEPTH_M.moderate };
  }
  return { key: "difficult", ...DRILLING_DEPTH_M.difficult };
}

// ---------------------------------------------------------------------------
// Access multiplier
// ---------------------------------------------------------------------------

function terrainWord(slopeProxy: number): string {
  if (slopeProxy < 0.15) return "flat";
  if (slopeProxy < 0.35) return "gently sloping";
  if (slopeProxy < 0.6) return "moderate";
  return "steep";
}

/**
 * Mobilisation and logistics surcharge. 1.00 for a roadside site on flat ground,
 * rising to 1.35 at SERVICE.maxRoadDistanceM on the steepest terrain.
 */
export function computeAccessMultiplier(
  distanceToRoadM: number,
  slopeProxy: number,
): { value: number; reason: string } {
  const distance = Number.isFinite(distanceToRoadM) ? Math.max(0, distanceToRoadM) : 0;
  const slope = clamp01(slopeProxy);
  const span = SERVICE.maxRoadDistanceM - ACCESS.roadsideThresholdM;
  const distanceFactor = span > 0 ? clamp01((distance - ACCESS.roadsideThresholdM) / span) : 0;

  const value = round2(
    1 + ACCESS.maxDistanceSurcharge * distanceFactor + ACCESS.maxSlopeSurcharge * slope,
  );
  const surchargePct = Math.round((value - 1) * 100);
  const head = `Site is ${qty(distance)} m from the nearest mapped road on ${terrainWord(slope)} terrain`;
  const reason =
    surchargePct === 0
      ? `${head} — no access surcharge applied.`
      : `${head} — ${surchargePct}% mobilisation and logistics surcharge applied.`;

  return { value, reason };
}

// ---------------------------------------------------------------------------
// Shared item groups
// ---------------------------------------------------------------------------

/** Storage, pipeline and tap stands, skipped when the upstream sizing is zero. */
function distributionItems(input: CostInput): CostLineItem[] {
  const items: CostLineItem[] = [];
  if (input.tankVolumeLiters > 0) {
    items.push(perUnitItem("Storage tank", input.tankVolumeLiters, "L", COST.tankPerLiter));
  }
  if (input.pipelineLengthM > 0) {
    items.push(
      perUnitItem("Distribution pipeline", input.pipelineLengthM, "m", COST.pipelinePerMeter),
    );
  }
  if (input.tapStandCount > 0) {
    items.push(perUnitItem("Tap stands", input.tapStandCount, "", COST.tapStand));
  }
  return items;
}

function monitoringItem(): CostLineItem {
  return lumpItem("Flow and status monitoring", COST.monitoringSensors);
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

function lineItemsFor(type: InfrastructureType, input: CostInput): CostLineItem[] {
  const items: CostLineItem[] = [
    lumpItem("Site preparation, access track and mobilisation", COST.sitePreparation),
  ];
  const band = depthBand(input.groundwaterConfidence);

  switch (type) {
    case "solar_borehole": {
      items.push(
        bandItem(
          "Borehole drilling and casing",
          band.low,
          band.high,
          "m",
          COST.drillingPerMeter,
          band.source,
        ),
      );
      items.push(lumpItem("Submersible pump and rising main", COST.submersiblePump));
      if (input.solarArrayWp > 0) {
        items.push(
          perUnitItem(
            "Solar array and pump controller",
            input.solarArrayWp,
            "Wp",
            COST.solarArrayPerWp,
          ),
        );
      }
      items.push(...distributionItems(input));
      items.push(lumpItem("Chlorination dosing at the tank outlet", COST.treatmentChlorination));
      items.push(monitoringItem());
      break;
    }

    case "borehole_rehabilitation": {
      // No new drilling: the existing borehole is flushed, re-developed and re-equipped.
      items.push(lumpItem("Borehole rehabilitation and re-development", COST.boreholeRehabilitation));
      items.push(lumpItem("Replacement hand pump and rising main", COST.handPump));
      items.push(...distributionItems(input));
      items.push(lumpItem("Chlorination dosing at the tank outlet", COST.treatmentChlorination));
      items.push(monitoringItem());
      break;
    }

    case "rainwater_harvesting": {
      // The catchment priced here is the inverse of the storage sizing rule.
      const catchmentAreaM2 = input.tankVolumeLiters / STORAGE_LITERS_PER_CATCHMENT_M2;
      if (catchmentAreaM2 > 0) {
        items.push(
          perUnitItem(
            "Roof catchment, guttering and first-flush diverters",
            catchmentAreaM2,
            "m2",
            COST.rainwaterCatchmentPerM2,
          ),
        );
      }
      items.push(...distributionItems(input));
      items.push(lumpItem("Chlorination and first-flush treatment", COST.treatmentChlorination));
      items.push(monitoringItem());
      break;
    }

    case "filtration_and_storage": {
      // Treats an existing but unsafe supply: no drilling, no abstraction pump.
      items.push(lumpItem("Filtration unit and media", COST.filtrationUnit));
      items.push(lumpItem("Chlorination and residual dosing", COST.treatmentChlorination));
      items.push(...distributionItems(input));
      items.push(monitoringItem());
      break;
    }

    case "community_storage_and_taps": {
      // Bulk supply (trucked or mains) into local storage: no on-site abstraction.
      items.push(...distributionItems(input));
      items.push(lumpItem("Chlorination dosing at the tank inlet", COST.treatmentChlorination));
      items.push(monitoringItem());
      break;
    }
  }

  return items;
}

function assumptionsFor(
  type: InfrastructureType,
  input: CostInput,
  band: DepthBand,
  access: { value: number; reason: string },
): string[] {
  const assumptions: string[] = [
    "Order-of-magnitude planning ranges for pre-feasibility screening — not a quotation, tender price or bill of quantities.",
    `Quantities are sized for approximately ${qty(input.peopleServed)} people at the service level assumed by the upstream sizing step.`,
    `Access surcharge applied to the subtotal: x${access.value.toFixed(2)}. ${access.reason}`,
    "Totals are rounded outward to the nearest $1,000 (low down, high up) to avoid implying precision the method does not have.",
    "Excludes land acquisition, taxes and import duties, permitting fees, contingency, and all recurrent operation and maintenance costs.",
    `All unit rates are taken unchanged from the project coefficient table (${COST.sitePreparation.source}).`,
  ];

  if (type === "solar_borehole") {
    assumptions.push(
      `Drilling priced against the "${band.key}" depth band (${band.low}-${band.high} m), selected by a groundwater evidence score of ${round2(clamp01(input.groundwaterConfidence)).toFixed(2)}. Actual depth is only known after drilling.`,
    );
    assumptions.push(
      `Solar array rated at ${qty(input.solarArrayWp)} Wp; no diesel or grid backup is priced.`,
    );
  }
  if (type === "borehole_rehabilitation") {
    assumptions.push(
      "Assumes the existing borehole is structurally sound and can be re-developed; if it cannot, the cost reverts to a new drilled borehole.",
    );
    assumptions.push(
      "Priced as a hand-pump reinstatement; a motorised and solarised upgrade would add pump, array and controller cost.",
    );
  }
  if (type === "rainwater_harvesting") {
    assumptions.push(
      `Catchment area is derived from storage at ${STORAGE_LITERS_PER_CATCHMENT_M2} L of tank per m2 of roof, matching the upstream sizing rule; it assumes existing institutional roofs are available for retrofit.`,
    );
  }
  if (type === "filtration_and_storage") {
    assumptions.push(
      "Assumes an existing raw-water supply can be gravity-fed to the treatment skid; no abstraction pump or borehole is priced.",
    );
  }
  if (type === "community_storage_and_taps") {
    assumptions.push(
      "Assumes bulk water is delivered by tanker or an existing main; the cost of that bulk supply is a recurrent cost and is not capitalised here.",
    );
  }

  return assumptions;
}

export function estimateCost(type: InfrastructureType, input: CostInput): CostEstimate {
  const lineItems = lineItemsFor(type, input);
  const subtotalLow = lineItems.reduce((sum, item) => sum + item.low, 0);
  const subtotalHigh = lineItems.reduce((sum, item) => sum + item.high, 0);

  const access = computeAccessMultiplier(input.distanceToRoadM, input.slopeProxy);

  // Planning precision: low rounds down, high rounds up, both to $1,000.
  const totalLow = Math.max(1000, Math.floor((subtotalLow * access.value) / 1000) * 1000);
  const totalHigh = Math.max(
    totalLow + 1000,
    Math.ceil((subtotalHigh * access.value) / 1000) * 1000,
  );

  return {
    lineItems,
    subtotalLow,
    subtotalHigh,
    accessMultiplier: access.value,
    accessMultiplierReason: access.reason,
    totalLow,
    totalHigh,
    currency: "USD",
    assumptions: assumptionsFor(type, input, depthBand(input.groundwaterConfidence), access),
  };
}
