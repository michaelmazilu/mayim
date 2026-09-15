import type {
  AnalysisRun,
  InfrastructureType,
  Partner,
  PartnerFocus,
  PartnerKind,
} from "@/lib/types";
import { countryIso2 } from "@/lib/geo/countries";

/**
 * Matches a site's recommended intervention against candidate partner
 * organisations, on resources needed (what this project requires) versus
 * resources available (what an organisation's role and track record imply
 * it can bring).
 *
 * This is a screening heuristic, not a funding decision: no organisation's
 * actual balance sheet, grant capacity, or annual budget is known or claimed
 * here. `kind` (funder / ngo / multilateral / utility / government / network)
 * is a real, verified fact about each organisation's role in the sector, and
 * "role fit against project scale" is a structural proxy that follows from
 * that role, not a specific financial claim about any named organisation.
 * That distinction matters: this file must never invent a dollar figure,
 * grant size, or capacity number for a real partner.
 */

// ---------------------------------------------------------------------------
// What the project needs
// ---------------------------------------------------------------------------

export type ProjectScale = "small" | "medium" | "large";

/** Total-cost breakpoints (USD, high end of the estimate range) for scale tiers. */
const SCALE_BREAKPOINTS = { small: 50_000, medium: 150_000 } as const;

export type ResourceNeed = {
  countryIso2: string | undefined;
  interventionType: InfrastructureType;
  /** High end of the formula-driven cost estimate — see lib/cost-model/cost.ts. */
  totalCostHighUsd: number;
  scale: ProjectScale;
  requiredFocus: PartnerFocus[];
  maintenanceComplexity: "low" | "moderate" | "high";
};

/** Which partner focus tags a given intervention type actually calls for. */
const FOCUS_FOR_TYPE: Record<InfrastructureType, PartnerFocus[]> = {
  solar_borehole: ["boreholes", "solar_pumping"],
  borehole_rehabilitation: ["boreholes", "maintenance"],
  rainwater_harvesting: ["rainwater"],
  filtration_and_storage: ["water_quality", "piped_schemes"],
  community_storage_and_taps: ["piped_schemes", "maintenance"],
};

function scaleFor(totalHigh: number): ProjectScale {
  if (totalHigh <= SCALE_BREAKPOINTS.small) return "small";
  if (totalHigh <= SCALE_BREAKPOINTS.medium) return "medium";
  return "large";
}

/** Derives what a completed AnalysisRun's recommendation actually requires. Returns null when there's no recommendation to match against. */
export function resourceNeedFor(run: AnalysisRun): ResourceNeed | null {
  const rec = run.recommendation;
  if (!rec) return null;
  const totalCostHighUsd = rec.cost.totalHigh;
  return {
    countryIso2: countryIso2(run.town.country),
    interventionType: rec.type,
    totalCostHighUsd,
    scale: scaleFor(totalCostHighUsd),
    requiredFocus: FOCUS_FOR_TYPE[rec.type],
    maintenanceComplexity: rec.maintenanceComplexity,
  };
}

// ---------------------------------------------------------------------------
// What a partner brings — role/scale affinity (structural, not financial data)
// ---------------------------------------------------------------------------

/**
 * How well an organisation's typical role in the WASH sector lines up with a
 * project of this cost tier. E.g. a global funder is a stronger fit for a
 * larger capital ask than a purely local implementer, and vice versa — this
 * reflects sector role, not any specific organisation's actual finances.
 */
const ROLE_SCALE_AFFINITY: Record<PartnerKind, Record<ProjectScale, number>> = {
  funder: { small: 0.5, medium: 0.8, large: 1.0 },
  multilateral: { small: 0.4, medium: 0.75, large: 1.0 },
  ngo: { small: 0.85, medium: 1.0, large: 0.7 },
  utility: { small: 0.5, medium: 0.9, large: 0.9 },
  government: { small: 0.7, medium: 0.85, large: 0.85 },
  network: { small: 0.6, medium: 0.75, large: 0.75 },
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const WEIGHTS = {
  focusFit: 0.4,
  countryPresence: 0.25,
  roleScaleFit: 0.2,
  evidenceQuality: 0.15,
} as const;

export type PartnerMatch = {
  partner: Partner;
  score: number; // 0..1
  reasons: string[];
};

function focusFitScore(need: ResourceNeed, partner: Partner): { score: number; reason: string } {
  const overlap = need.requiredFocus.filter((f) => partner.focus.includes(f));
  if (overlap.length === 0) {
    return { score: 0, reason: "No overlap with this project's required focus areas" };
  }
  const score = overlap.length / need.requiredFocus.length;
  return { score, reason: `Works on ${overlap.join(", ")}` };
}

function countryPresenceScore(need: ResourceNeed, partner: Partner): { score: number; reason: string } {
  if (need.countryIso2 && partner.country === need.countryIso2) {
    return { score: 1, reason: "Active in this country" };
  }
  if (partner.country === "global") {
    return { score: 0.6, reason: "Global organisation, no confirmed country-specific programme checked here" };
  }
  return { score: 0, reason: "No confirmed presence in this country" };
}

function roleScaleScore(need: ResourceNeed, partner: Partner): { score: number; reason: string } {
  const score = ROLE_SCALE_AFFINITY[partner.kind][need.scale];
  return {
    score,
    reason: `${partner.kind} role, ${need.scale}-scale project (est. up to $${need.totalCostHighUsd.toLocaleString("en-US")})`,
  };
}

function evidenceQualityScore(partner: Partner): { score: number; reason: string } {
  if (partner.source === "verified") {
    return { score: 1, reason: `Verified listing${partner.lastVerified ? ` (checked ${partner.lastVerified})` : ""}` };
  }
  return { score: 0.5, reason: "Surfaced by live search, not manually reviewed" };
}

/**
 * Ranks candidate partners against a project's resource need. Partners with
 * zero country presence AND zero focus overlap are dropped outright — they
 * are not a fit under any weighting, not merely a low score.
 */
export function matchPartners(need: ResourceNeed, partners: Partner[]): PartnerMatch[] {
  const scored: PartnerMatch[] = [];

  for (const partner of partners) {
    const focus = focusFitScore(need, partner);
    const country = countryPresenceScore(need, partner);
    if (focus.score === 0 && country.score === 0) continue;

    const role = roleScaleScore(need, partner);
    const evidence = evidenceQualityScore(partner);

    const score =
      focus.score * WEIGHTS.focusFit +
      country.score * WEIGHTS.countryPresence +
      role.score * WEIGHTS.roleScaleFit +
      evidence.score * WEIGHTS.evidenceQuality;

    scored.push({
      partner,
      score: Math.round(score * 1000) / 1000,
      reasons: [focus.reason, country.reason, role.reason, evidence.reason],
    });
  }

  return scored.sort((a, b) => b.score - a.score);
}
