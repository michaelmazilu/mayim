/**
 * Behavioural and operational rates for the population simulation.
 *
 * Same contract as coefficients.ts: every number carries its source and a URL,
 * and nothing here is invented. Where a figure is DERIVED from sourced inputs
 * (e.g. breakdown frequency from downtime share and repair time), the helper
 * shows the formula instead of hiding a constant. Gaps that could not be
 * sourced are listed at the bottom rather than filled.
 *
 * Retrieved 2026-09-15.
 */

export type Rate = {
  low: number;
  central: number;
  high: number;
  unit: string;
  source: string;
  url: string;
  note?: string;
};

type Iso = "KE" | "UG" | "GH";

// ---------------------------------------------------------------------------
// Population growth — World Bank WDI, 2025 values
// ---------------------------------------------------------------------------

const WDI = "World Bank World Development Indicators (2025)";
const wdiUrl = (iso2: string) => `https://data.worldbank.org/indicator/SP.URB.GROW?locations=${iso2}`;

/**
 * low = total population growth (SP.POP.GROW), central/high = urban population
 * growth (SP.URB.GROW). City-level intercensal rates for Kisumu, Gulu and
 * Tamale were not sourced; peri-urban fringes plausibly grow faster than the
 * national urban average, but no figure is claimed for that.
 */
export const POPULATION_GROWTH: Record<Iso | "SSA", Rate> = {
  KE: { low: 1.93, central: 2.92, high: 2.92, unit: "%/yr", source: WDI, url: wdiUrl("KE") },
  UG: { low: 2.7, central: 4.8, high: 4.8, unit: "%/yr", source: WDI, url: wdiUrl("UG") },
  GH: { low: 1.83, central: 2.79, high: 2.79, unit: "%/yr", source: WDI, url: wdiUrl("GH") },
  SSA: {
    low: 2.43,
    central: 3.58,
    high: 3.58,
    unit: "%/yr",
    source: `${WDI}, Sub-Saharan Africa aggregate`,
    url: wdiUrl("ZG"),
    note: "Fallback for countries without a specific entry.",
  },
};

export function populationGrowthRate(iso2: string | undefined): Rate {
  const code = iso2?.toUpperCase();
  return code && code in POPULATION_GROWTH ? POPULATION_GROWTH[code as Iso] : POPULATION_GROWTH.SSA;
}

/**
 * Town-level intercensal growth, keyed by town slug, where a boundary-consistent
 * figure exists. Two demo towns are absent on purpose and use the national rate:
 *   - Tamale: Sagnarigu district was split from Tamale Metropolitan in 2012, so
 *     the 2010 and 2021 census counts cover different areas.
 *   - Gulu: became a city in 2020 with a larger boundary. 2024 is 232,723
 *     (UBOS), but published 2014 baselines disagree (150,306 municipality,
 *     152,276, and a recomputed 185,042 we could not verify), so no rate is claimed.
 */
export const CITY_GROWTH: Record<string, Rate> = {
  "kisumu-kenya": {
    low: 1.78,
    central: 1.78,
    high: 1.78,
    unit: "%/yr",
    source: "KNBS census: Kisumu County 968,909 (2009) → 1,155,574 (2019), compound annual rate",
    url: "https://www.knbs.or.ke/wp-content/uploads/2023/09/2015-County-Statistical-Abstracts-Kisumu.pdf",
    note: "County-wide, including rural areas; the city itself plausibly grows faster.",
  },
};

/** The town's own sourced rate when there is one, otherwise the national rate. */
export function growthRateForTown(slug: string | undefined, iso2: string | undefined): Rate {
  return (slug ? CITY_GROWTH[slug] : undefined) ?? populationGrowthRate(iso2);
}

// ---------------------------------------------------------------------------
// Household size — national censuses
// ---------------------------------------------------------------------------

export const HOUSEHOLD_SIZE: Record<Iso, Rate> = {
  KE: {
    low: 3.9,
    central: 3.9,
    high: 3.9,
    unit: "people/household",
    source: "KNBS, 2019 Kenya Population and Housing Census",
    url: "https://www.knbs.or.ke/2019-kenya-population-and-housing-census-results/",
    note: "National mean (down from 4.2 in 2009).",
  },
  UG: {
    low: 4.7,
    central: 4.7,
    high: 4.7,
    unit: "people/household",
    source: "UBOS, National Population and Housing Census 2014",
    url: "https://www.ubos.org/wp-content/uploads/publications/03_20182014_National_Census_Main_Report.pdf",
    note: "National mean; districts range roughly 4.5–5.5.",
  },
  GH: {
    low: 3.6,
    central: 3.6,
    high: 3.6,
    unit: "people/household",
    source: "Ghana Statistical Service, 2021 Population and Housing Census",
    url: "https://census2020.statsghana.gov.gh/presspage.php",
    note: "National mean.",
  },
};

/** Unknown countries get the span of the three sourced censuses. */
export function householdSize(iso2: string | undefined): Rate {
  const code = iso2?.toUpperCase();
  if (code && code in HOUSEHOLD_SIZE) return HOUSEHOLD_SIZE[code as Iso];
  return {
    low: 3.6,
    central: 3.9,
    high: 4.7,
    unit: "people/household",
    source: "Span of Kenya 2019, Uganda 2014 and Ghana 2021 census means",
    url: HOUSEHOLD_SIZE.KE.url,
    note: "No country-specific figure — screening fallback.",
  };
}

// ---------------------------------------------------------------------------
// Breakdowns and repair
// ---------------------------------------------------------------------------

/** Share of water points not working on any given day. */
export const WATER_POINT_DOWN_SHARE: Rate = {
  low: 0.16,
  central: 0.25,
  high: 0.36,
  unit: "share non-functional at any time",
  source:
    "low: Uganda MWE Sector Performance Report 2018 (84% rural functionality); " +
    "central: UPGro Hidden Crisis / RWSN (\"more than 25% of handpumps non-functional at any time\"); " +
    "high: RWSN 2009 handpump data, 20 SSA countries (36%)",
  url: "https://upgro.org/consortium/hidden-crisis2/",
  note: "Includes abandoned points that are never repaired, so it overstates the share a managed scheme would see.",
};

/** Country-specific share of handpump/borehole points down, where a sourced figure exists. */
export const WATER_POINT_DOWN_SHARE_BY_COUNTRY: Partial<Record<Iso, Rate>> = {
  UG: {
    low: 0.16,
    central: 0.16,
    high: 0.16,
    unit: "share non-functional at any time",
    source: "Uganda MWE Sector Performance Report 2018 (84% functionality of rural boreholes and handpumps)",
    url: "https://www.mwe.go.ug/library/sector-performance-reports",
  },
  GH: {
    low: 0.13,
    central: 0.16,
    high: 0.19,
    unit: "share non-functional at any time",
    source:
      "Schultes et al. (2022), Longitudinal borehole functionality in 15 rural Ghanaian towns, BMC Research Notes (\"BH functionality rates ranged between 81 and 87%\")",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC8939079/",
    note: "Eastern Region, 2014–16 — not Northern Region. central is the midpoint.",
  },
};

/** Motorised / piped schemes under normal (non-drought) conditions. */
export const MOTORISED_SCHEME_DOWN_SHARE: Rate = {
  low: 0.35,
  central: 0.4,
  high: 0.45,
  unit: "share not fully operational",
  source:
    "UNICEF/REACH/Oxford, Maintaining Africa's water infrastructure: Water Audit in Kitui County, Kenya (2016) " +
    "(\"Over half the schemes are operational (55%) and 10% are partly functional\")",
  url: "https://reachwater.uk/wp-content/uploads/2024/01/16_09_05_Kitui-policy-brief.pdf",
  note: "low = not operational; high = not operational or only partly functional; central is the midpoint. One county.",
};

/** Days a broken point stays down. */
export const REPAIR_DAYS: Record<
  "communityManaged" | "professionalService" | "pipedCommunityManaged" | "motorisedCommunityManaged",
  Rate
> = {
  communityManaged: {
    low: 30,
    central: 43,
    high: 150,
    unit: "days",
    source:
      "central: Oxford REACH Kitui maintenance policy brief (handpumps 43 days without professional maintenance); " +
      "low: FundiFix baseline (\"over 30 days\"); high: Stanford/Whave Uganda (\"can exceed 150 days\")",
    url: "https://www.smithschool.ox.ac.uk/sites/default/files/2022-02/Kitui-maintenance-policy-brief_0.pdf",
  },
  professionalService: {
    low: 1,
    central: 2,
    high: 3,
    unit: "days",
    source:
      "FundiFix, Kenya (98% of repairs within three days); Whave, Uganda (repair by end of next day); " +
      "REACH (\"less than two days\")",
    url: "https://www.smithschool.ox.ac.uk/article/investing-professionalised-maintenance-increase-social-and-economic-returns-drinking-water",
  },
  pipedCommunityManaged: {
    low: 46,
    central: 56,
    high: 67,
    unit: "days",
    source: "Oxford REACH Kitui maintenance policy brief (piped systems 46–67 days without professional maintenance)",
    url: "https://www.smithschool.ox.ac.uk/sites/default/files/2022-02/Kitui-maintenance-policy-brief_0.pdf",
    note: "central is the midpoint of the published range.",
  },
  motorisedCommunityManaged: {
    low: 90,
    central: 195,
    high: 300,
    unit: "days",
    source:
      "UNICEF/REACH/Oxford Kitui County Water Audit (2016) (\"Average breakdown times vary from three months for a minor repair to ten months for a major repair\")",
    url: "https://reachwater.uk/wp-content/uploads/2024/01/16_09_05_Kitui-policy-brief.pdf",
    note: "Pump and genset failures dominate. central is the midpoint.",
  },
};

/**
 * Mean days between breakdowns, derived from steady-state availability:
 *   downShare = MTTR / (MTBF + MTTR)  ⇒  MTBF = MTTR · (1 − downShare) / downShare
 * With 25% down and 43-day repairs that is ~129 days (~2.8 breakdowns/yr).
 */
export function meanDaysBetweenBreakdowns(downShare: number, repairDays: number): number {
  const p = Math.min(0.95, Math.max(0.01, downShare));
  return (repairDays * (1 - p)) / p;
}

/** Probability a working point breaks during a 7-day step (exponential failure model). */
export function weeklyBreakdownProbability(downShare: number, repairDays: number): number {
  return 1 - Math.exp(-7 / meanDaysBetweenBreakdowns(downShare, repairDays));
}

// ---------------------------------------------------------------------------
// Dry season and drought
// ---------------------------------------------------------------------------

const MACALLISTER =
  "MacAllister, MacDonald, Kebede, Godfrey & Calow (2020), Comparative performance of rural water supplies during drought, Nature Communications";
const MACALLISTER_URL = "https://pmc.ncbi.nlm.nih.gov/articles/PMC7055361/";

/** Mean functionality during the 2015–16 Ethiopian drought, by source type. */
export const DROUGHT_FUNCTIONALITY: Record<"handpump" | "motorised", Rate> = {
  handpump: { low: 0.75, central: 0.75, high: 0.75, unit: "share functional", source: MACALLISTER, url: MACALLISTER_URL },
  motorised: { low: 0.6, central: 0.6, high: 0.6, unit: "share functional", source: MACALLISTER, url: MACALLISTER_URL },
};

/** Collection time at handpumps: "<30 min, increasing to 30–60 mins" in drought. */
export const DRY_SEASON_COLLECTION_MINUTES: Rate = {
  low: 30,
  central: 45,
  high: 60,
  unit: "minutes per collection trip (drought peak)",
  source: MACALLISTER,
  url: MACALLISTER_URL,
  note: "Normal-season baseline was under 30 minutes. central is the midpoint.",
};

// ---------------------------------------------------------------------------
// Walking and fetching
// ---------------------------------------------------------------------------

export const WALKING_SPEED_M_PER_S: Rate = {
  low: 0.86,
  central: 0.97,
  high: 1.3,
  unit: "m/s",
  source:
    "low/central: water-carrying study (3.1 km/h outbound, 3.5 km/h loaded return); " +
    "high: typical unloaded pedestrian speed (~1.2–1.4 m/s)",
  url: "https://www.longdom.org/open-access/determination-of-safe-carrying-load-limit-for-women-carrying-water-19446.html",
  note: "Single regional study — indicative, not a multi-country figure.",
};

/** JMP "basic" drinking-water service: collection within a 30-minute round trip, including queuing. */
export const BASIC_SERVICE_ROUND_TRIP_MIN = { value: 30, source: "WHO/UNICEF JMP service ladder", url: "https://washdata.org/monitoring/drinking-water" };

/** Sphere Handbook 2018, water supply standard 2.1. */
export const SPHERE = {
  tapFlowLitersPerMin: 7.5,
  handpumpFlowLitersPerMin: 17,
  openWellFlowLitersPerMin: 12.5,
  maxPeoplePerTap: 250,
  maxPeoplePerHandpump: 500,
  maxPeoplePerOpenWell: 400,
  maxQueueMinutes: 30,
  maxDistanceM: 500,
  source: "Sphere Handbook 2018, Water supply standard 2.1",
  url: "https://spherestandards.org/wp-content/uploads/Sphere-Handbook-2018-EN.pdf",
} as const;

/** De facto collection container — a logistics convention, not a WASH standard. */
export const CONTAINER_LITERS = { value: 20, source: "Standard 20 L jerrycan (de facto container size)" } as const;

/** Per-capita demand by service level. */
export const DEMAND_LITERS_PER_PERSON_DAY = {
  survival: { value: 15, source: "Sphere Handbook 2018 (minimum; a floor, not a design target)", url: SPHERE.url },
  basic: { value: 20, source: "Howard et al., Domestic water quantity, service level and health, WHO 2020", url: "https://www.who.int/publications/i/item/9789240015241" },
  intermediate: { value: 50, source: "Howard et al., WHO 2020", url: "https://www.who.int/publications/i/item/9789240015241" },
  optimal: { value: 100, source: "Howard et al., WHO 2020", url: "https://www.who.int/publications/i/item/9789240015241" },
} as const;

export function fillMinutes(liters: number, flowLitersPerMin: number): number {
  return flowLitersPerMin > 0 ? liters / flowLitersPerMin : Infinity;
}

/** One-way walking time. */
export function walkMinutes(distanceM: number, speedMPerS = WALKING_SPEED_M_PER_S.central): number {
  return speedMPerS > 0 ? distanceM / speedMPerS / 60 : Infinity;
}

/** Round trip = walk there + queue + fill + walk back. Compare against BASIC_SERVICE_ROUND_TRIP_MIN. */
export function roundTripMinutes(args: {
  distanceM: number;
  queueMinutes?: number;
  liters?: number;
  flowLitersPerMin?: number;
  speedMPerS?: number;
}): number {
  const walk = 2 * walkMinutes(args.distanceM, args.speedMPerS);
  const fill = fillMinutes(args.liters ?? CONTAINER_LITERS.value, args.flowLitersPerMin ?? SPHERE.tapFlowLitersPerMin);
  return walk + (args.queueMinutes ?? 0) + fill;
}

/**
 * Not sourced, deliberately left out:
 *   - boundary-consistent growth rates for Tamale (Sagnarigu split off in 2012)
 *     and Gulu (city boundary created 2020; 2014 baselines conflict);
 *   - a Northern Region Ghana functionality rate (the Ghana figure is Eastern Region);
 *   - Uganda national motorised-scheme functionality.
 */
