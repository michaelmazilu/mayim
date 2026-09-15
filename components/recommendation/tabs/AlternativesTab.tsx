"use client";

import type { JSX } from "react";
import type { AnalysisRun, Candidate, ScoreBreakdown } from "@/lib/types";
import { WEIGHTS, WEIGHT_LABELS } from "@/lib/config/coefficients";

type FactorKey = keyof ScoreBreakdown & keyof typeof WEIGHTS;

const FACTORS: FactorKey[] = [
  "communityNeed",
  "populationAccessProxy",
  "groundwaterFeasibility",
  "roadAndConstructionAccess",
  "distanceFromExistingService",
  "environmentalSafety",
  "evidenceQuality",
];

/** U+2212 minus so negative deltas align with the digits. */
function signed(delta: number, digits: number): string {
  const rounded = Number(delta.toFixed(digits));
  if (rounded === 0) return `±${(0).toFixed(digits)}`;
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(digits)}`;
}

function deltaClass(delta: number): string {
  const rounded = Number(delta.toFixed(3));
  if (rounded > 0) return "text-[color:var(--st-ok)]";
  if (rounded < 0) return "text-[color:var(--st-bad)]";
  return "text-[color:var(--text-muted)]";
}

/** Distinct hard-constraint reasons with counts, ordered deterministically. */
function exclusionReasons(candidates: Candidate[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (!c.excluded) continue;
    for (const reason of c.score.exclusions) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));
}

export function AlternativesTab(props: {
  run: AnalysisRun;
  onFocusCandidate?: (id: string | null) => void;
}): JSX.Element {
  const { run, onFocusCandidate } = props;

  const byId = new Map(run.candidates.map((c) => [c.id, c]));
  const top = run.ranked
    .slice(0, 3)
    .map((id) => byId.get(id))
    .filter((c): c is Candidate => c !== undefined);
  const winner = top.length > 0 ? top[0] : null;
  const reasons = exclusionReasons(run.candidates);

  const focus = (id: string | null) => {
    if (onFocusCandidate) onFocusCandidate(id);
  };

  return (
    <div>
      <h3 className="lbl">
        Ranked candidates
      </h3>

      {top.length === 0 || !winner ? (
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
          No candidate site passed the hard constraints, so there is nothing to compare.
        </p>
      ) : (
        <div className="mt-2.5 space-y-2.5">
          {top.map((cand, index) => {
            const isWinner = index === 0;
            const delta = cand.score.overall - winner.score.overall;
            const comparison =
              run.alternatives.find((a) => a.candidateId === cand.id)?.comparison ?? null;

            return (
              <div
                key={cand.id}
                onMouseEnter={() => focus(cand.id)}
                onMouseLeave={() => focus(null)}
                onFocus={() => focus(cand.id)}
                onBlur={() => focus(null)}
                onClick={() => focus(cand.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") focus(cand.id);
                }}
                className={`cursor-pointer  border px-3 py-2.5 transition-colors duration-200 focus:outline-none ${
                  isWinner
                    ? "border-[color:var(--accent)] bg-[var(--accent-soft)]"
                    : "border-[color:var(--border)] bg-[var(--bg-sunken)] hover:border-[color:var(--border)]"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="lbl">
                        Rank {index + 1}
                      </span>
                      {isWinner ? (
                        <span className="border border-[color:var(--accent)] bg-[var(--accent-soft)] px-1.5 py-0.5 lbl">
                          Selected
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1.5 truncate mono text-[11px] text-[color:var(--text)]">
                      {cand.id}
                    </div>
                    <div className="mt-1 mono text-[9.5px] tracking-[0.1em] num text-[color:var(--text-muted)]">
                      {cand.lat.toFixed(6)}
                      <span className="mx-1.5 text-[color:var(--text-subtle)]">/</span>
                      {cand.lon.toFixed(6)}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div
                      className={`text-[17px] font-[400] leading-none num ${
                        isWinner ? "text-[color:var(--accent)]" : "text-[color:var(--text)]"
                      }`}
                    >
                      {cand.score.overall.toFixed(3)}
                    </div>
                    <div
                      className={`mt-1.5 mono text-[9.5px] num ${
                        isWinner ? "text-[color:var(--text-muted)]" : deltaClass(delta)
                      }`}
                    >
                      {isWinner ? "best overall" : `${signed(delta, 3)} overall`}
                    </div>
                  </div>
                </div>

                {comparison ? (
                  <p className="mt-2 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">{comparison}</p>
                ) : null}

                {!isWinner ? (
                  <div className="mt-2.5 border-t border-[color:var(--border)] pt-2">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-2 gap-y-1">
                      <span className="lbl">
                        Factor
                      </span>
                      <span className="text-right lbl">
                        Alt
                      </span>
                      <span className="text-right lbl">
                        Win
                      </span>
                      <span className="text-right lbl">
                        Δ
                      </span>

                      {FACTORS.map((key) => {
                        const alt = cand.score.breakdown[key];
                        const win = winner.score.breakdown[key];
                        const d = alt - win;
                        return (
                          <FactorRow
                            key={key}
                            label={WEIGHT_LABELS[key]}
                            alt={alt}
                            win={win}
                            delta={d}
                          />
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <section className="mt-6">
        <h3 className="lbl">
          Hard constraints
        </h3>
        <p className="mt-2.5 text-[12px] leading-relaxed text-[color:var(--text)]">
          {run.excludedCount} of {run.candidateCount} candidates excluded by hard constraints
        </p>

        {reasons.length === 0 ? (
          <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--text-muted)]">
            No exclusion reasons were recorded for this run.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {reasons.map((r) => (
              <li
                key={r.reason}
                className="flex items-baseline justify-between gap-3 border-b border-[color:var(--border-subtle)] pb-1.5 last:border-b-0"
              >
                <span className="text-[11.5px] leading-snug text-[color:var(--text-muted)]">{r.reason}</span>
                <span className="shrink-0 mono text-[10px] num text-[color:var(--text-muted)]">
                  {r.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FactorRow(props: {
  label: string;
  alt: number;
  win: number;
  delta: number;
}): JSX.Element {
  const { label, alt, win, delta } = props;
  return (
    <>
      <span className="truncate text-[11px] leading-tight text-[color:var(--text-muted)]">{label}</span>
      <span className="text-right mono text-[10px] num text-[color:var(--text)]">
        {alt.toFixed(2)}
      </span>
      <span className="text-right mono text-[10px] num text-[color:var(--text-muted)]">
        {win.toFixed(2)}
      </span>
      <span className={`text-right mono text-[10px] num ${deltaClass(delta)}`}>
        {signed(delta, 2)}
      </span>
    </>
  );
}
