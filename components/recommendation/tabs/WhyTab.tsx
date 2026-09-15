"use client";

import type { JSX } from "react";
import type { AnalysisRun, ScoreBreakdown } from "@/lib/types";
import { WEIGHTS, WEIGHT_LABELS } from "@/lib/config/coefficients";
import { ScoreBar } from "@/components/ui/ScoreBar";

type FactorKey = keyof ScoreBreakdown & keyof typeof WEIGHTS;

/** Fixed render order — keeps the breakdown stable across runs. */
const FACTORS: FactorKey[] = [
  "communityNeed",
  "populationAccessProxy",
  "groundwaterFeasibility",
  "roadAndConstructionAccess",
  "distanceFromExistingService",
  "environmentalSafety",
  "evidenceQuality",
];

const KIND_CHIP: Record<"map" | "evidence" | "assumption", { text: string; className: string }> = {
  map: {
    text: "Map feature",
    className: "border-[color:var(--accent)] bg-[rgba(14,165,233,0.09)] text-[color:var(--accent)]",
  },
  evidence: {
    text: "Evidence",
    className: "border-[rgba(52,211,153,0.28)] bg-[rgba(16,185,129,0.09)] text-[color:var(--st-ok)]",
  },
  assumption: {
    text: "Assumption",
    className: "border-[color:var(--border)] bg-[rgba(245,158,11,0.09)] text-[color:var(--st-warn)]",
  },
};

export function WhyTab(props: {
  run: AnalysisRun;
  onFocusCandidate?: (id: string | null) => void;
}): JSX.Element {
  const { run } = props;
  const winner = run.candidates.find((c) => c.id === run.winnerId) ?? null;

  return (
    <div>
      <section>
        <h3 className="lbl">
          Why this site
        </h3>

        {run.whyThisSite.length === 0 ? (
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
            No site-specific justification was recorded for this run.
          </p>
        ) : (
          <ul className="mt-2.5 space-y-2.5">
            {run.whyThisSite.map((item, i) => {
              const chip = KIND_CHIP[item.kind];
              const finding =
                item.kind === "evidence" && item.evidenceId
                  ? (run.findings.find((f) => f.id === item.evidenceId) ?? null)
                  : null;
              const href = finding && finding.sourceUrl ? finding.sourceUrl : null;

              return (
                <li
                  key={`${i}-${item.claim}`}
                  className="border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[12.5px] leading-snug text-[color:var(--text)]">{item.claim}</p>
                    <span
                      className={`shrink-0 whitespace-nowrap border px-1.5 py-0.5 lbl ${chip.className}`}
                    >
                      {chip.text}
                    </span>
                  </div>

                  <p className="mt-1.5 text-[11px] leading-relaxed text-[color:var(--text-muted)]">{item.basis}</p>

                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-block lbl text-[color:var(--st-ok)] transition-colors duration-200 hover:text-[color:var(--st-ok)]"
                    >
                      {finding ? finding.sourceName : "Source"} ↗
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="lbl">
            Score breakdown
          </h3>
          {winner ? (
            <span className="mono text-[10px] num text-[color:var(--text-muted)]">
              {winner.id}
              <span className="mx-1.5 text-[color:var(--text-subtle)]">·</span>
              {winner.score.overall.toFixed(3)}
            </span>
          ) : null}
        </div>

        {winner ? (
          <>
            <div className="mt-3 space-y-3">
              {FACTORS.map((key, i) => (
                <ScoreBar
                  key={key}
                  label={WEIGHT_LABELS[key]}
                  value={winner.score.breakdown[key]}
                  weight={WEIGHTS[key]}
                  delay={0.06 * i}
                />
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-snug text-[color:var(--text-subtle)]">
              Each factor is normalised to 0–1 and combined using the weights shown at right.
            </p>

            {winner.score.warnings.length > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {winner.score.warnings.map((w, i) => (
                  <li
                    key={`${i}-${w}`}
                    className="flex gap-2 text-[11px] leading-relaxed text-[color:var(--st-warn)]"
                  >
                    <span className="mt-[7px] h-[3px] w-[3px] shrink-0 bg-[var(--st-warn)]" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
            No winning candidate survived the hard constraints, so there is no score breakdown to
            show.
          </p>
        )}
      </section>
    </div>
  );
}
