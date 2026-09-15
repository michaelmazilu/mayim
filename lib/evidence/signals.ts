/**
 * Deterministic roll-up of evidence findings into scoring signals.
 *
 * Pure functions only: no clock, no randomness, no network. The same findings
 * always produce byte-identical signals, which is what makes a cached or
 * replayed run reproduce the original scores exactly.
 */

import type { EvidenceFinding, EvidenceSignals, ScoreFactor } from "@/lib/types";

const FACTORS: readonly ScoreFactor[] = ["need", "groundwater", "risk", "cost", "access"];

/** Neutral starting point before any evidence is applied. */
const FACTOR_BASELINE = 0.5;

/** Findings needed before the evidence base counts as fully covered. */
const FULL_COVERAGE_FINDINGS = 6;

/** Quality assigned when there is no evidence at all. */
const NO_EVIDENCE_QUALITY = 0.25;

/**
 * Evidence can move a factor at most this far from its baseline, however many
 * sources agree — the same ceiling llm.ts puts on a single finding. Without it,
 * a live search returning a dozen same-direction findings pins factors to 0 or
 * 1 and the desk study reads as certainty. More agreeing sources still raise
 * `quality` through coverage.
 */
export const MAX_FACTOR_SHIFT = 0.35;

/** Sign-preserving saturation: ≈ linear for small sums, approaching ±MAX_FACTOR_SHIFT for large ones. */
function boundedShift(raw: number): number {
  return MAX_FACTOR_SHIFT * Math.tanh(raw / MAX_FACTOR_SHIFT);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function emptyContributors(): Record<ScoreFactor, string[]> {
  return { need: [], groundwater: [], risk: [], cost: [], access: [] };
}

/**
 * Stable id ordering: numeric where ids look like "f12", lexicographic
 * otherwise. Avoids "f10" sorting before "f2" while staying deterministic for
 * arbitrary id shapes.
 */
function compareIds(a: string, b: string): number {
  const na = /^f(\d+)$/.exec(a);
  const nb = /^f(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic fallback used when there is no evidence at all. */
export const NEUTRAL_SIGNALS: EvidenceSignals = {
  need: 0.5,
  groundwater: 0.45, // absence of evidence is not evidence of a productive aquifer
  risk: 0.4,
  cost: 0.5,
  access: 0.5,
  quality: NO_EVIDENCE_QUALITY,
  contributors: emptyContributors(),
};

function neutralCopy(): EvidenceSignals {
  return { ...NEUTRAL_SIGNALS, contributors: emptyContributors() };
}

/** Pure, deterministic. Same findings -> identical signals. */
export function aggregateSignals(findings: EvidenceFinding[]): EvidenceSignals {
  if (findings.length === 0) return neutralCopy();

  // Raw signed evidence per factor, bounded once every finding is counted.
  const shifts: Record<ScoreFactor, number> = { need: 0, groundwater: 0, risk: 0, cost: 0, access: 0 };
  const values = { ...shifts };
  const contributors = emptyContributors();

  let confidenceSum = 0;
  for (const finding of findings) {
    const confidence = clamp01(finding.confidence);
    confidenceSum += confidence;

    const impact = finding.scoreImpact;
    if (!impact) continue;
    if (!FACTORS.includes(impact.factor)) continue;

    const magnitude = clamp01(impact.magnitude);
    const sign = impact.direction === "increase" ? 1 : impact.direction === "decrease" ? -1 : 0;
    shifts[impact.factor] += sign * magnitude * confidence;
    contributors[impact.factor].push(finding.id);
  }

  for (const factor of FACTORS) {
    values[factor] = clamp01(FACTOR_BASELINE + boundedShift(shifts[factor]));
    contributors[factor].sort(compareIds);
  }

  // Thin evidence bases score lower even when each individual source is strong.
  const meanConfidence = confidenceSum / findings.length;
  const coverage = Math.min(1, findings.length / FULL_COVERAGE_FINDINGS);

  return {
    need: values.need,
    groundwater: values.groundwater,
    risk: values.risk,
    cost: values.cost,
    access: values.access,
    quality: clamp01(meanConfidence * coverage),
    contributors,
  };
}
