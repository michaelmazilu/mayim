"use client";

import { useState, type JSX } from "react";
import type { AnalysisRun } from "@/lib/types";
import { Disclosure } from "@/components/ui/Disclosure";

/**
 * Deterministic explanatory line per validation step, matched on keywords in the
 * step text. First match wins; order matters.
 */
const NOTES: { match: string; note: string }[] = [
  {
    match: "hydrogeolog",
    note: "Confirms the aquifer exists, its depth, and a sustainable yield before any drilling contract.",
  },
  {
    match: "geophys",
    note: "On-site resistivity or seismic survey positions the borehole; desktop screening cannot.",
  },
  {
    match: "water quality",
    note: "Laboratory testing for bacteriological and chemical contamination at the abstraction depth.",
  },
  {
    match: "yield",
    note: "Pumping test establishes the rate the source can actually sustain across a dry season.",
  },
  {
    match: "land",
    note: "Written land tenure and community consent for the site and its service area.",
  },
  {
    match: "permit",
    note: "Abstraction and construction permits vary by district and must be confirmed locally.",
  },
  {
    match: "licen",
    note: "Licensed engineering sign-off is required before any design becomes buildable.",
  },
  {
    match: "regulat",
    note: "National and county water regulations govern siting, abstraction, and tariffs.",
  },
  {
    match: "survey",
    note: "A physical site visit verifies conditions the mapped data cannot represent.",
  },
  {
    match: "communit",
    note: "Engagement with the community that will own, operate, and pay for the system.",
  },
  {
    match: "maintenance",
    note: "A funded maintenance plan is the strongest predictor of long-term function.",
  },
  {
    match: "operat",
    note: "Operating model, tariff, and spare-parts supply chain must be agreed up front.",
  },
  {
    match: "flood",
    note: "Field verification of flood exposure; the model uses a terrain-derived proxy only.",
  },
  {
    match: "contamin",
    note: "Sanitary inspection of upgradient latrines, waste, and industrial activity.",
  },
  {
    match: "access",
    note: "Confirm a drilling rig and materials can physically reach the site in all seasons.",
  },
  {
    match: "road",
    note: "Confirm a drilling rig and materials can physically reach the site in all seasons.",
  },
  {
    match: "cost",
    note: "Contractor quotations replace the planning ranges used in this screening.",
  },
  {
    match: "quot",
    note: "Contractor quotations replace the planning ranges used in this screening.",
  },
];

function noteFor(step: string): string {
  const lower = step.toLowerCase();
  const hit = NOTES.find((n) => lower.includes(n.match));
  return hit
    ? hit.note
    : "Verify on site before committing capital; this screening cannot confirm it remotely.";
}

export function ValidationTab(props: {
  run: AnalysisRun;
  onFocusCandidate?: (id: string | null) => void;
}): JSX.Element {
  const { run } = props;
  const steps = run.recommendation?.requiredValidation ?? [];
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  const toggle = (i: number) => setChecked((prev) => ({ ...prev, [i]: !prev[i] }));

  return (
    <div>
      <section>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="lbl">
            Required validation
          </h3>
          {steps.length > 0 ? (
            <span className="mono text-[10px] num text-[color:var(--text-muted)]">
              {steps.filter((_, i) => checked[i]).length}/{steps.length}
            </span>
          ) : null}
        </div>

        {steps.length === 0 ? (
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
            No validation checklist was produced — this run did not reach an infrastructure
            recommendation.
          </p>
        ) : (
          <ul className="mt-2.5 space-y-1">
            {steps.map((step, i) => {
              const on = checked[i] === true;
              return (
                <li key={`${i}-${step}`}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(i)}
                    className="flex w-full gap-2.5 px-2 py-2 text-left transition-colors duration-200 hover:bg-[var(--bg-sunken)] focus:outline-none focus-visible:bg-[var(--bg-sunken)]"
                  >
                    <span
                      className={`mt-[2px] grid h-[13px] w-[13px] shrink-0 place-items-center border transition-colors duration-100 ${
                        on
                          ? "border-[color:var(--text)] bg-[var(--text)] text-[var(--paper)]"
                          : "border-[color:var(--grey-4)]"
                      }`}
                    >
                      {on ? (
                        <svg viewBox="0 0 12 12" className="h-[8px] w-[8px]" aria-hidden="true">
                          <path
                            d="M1.7 6.3 4.5 9.1 10.3 3"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : null}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={`block text-[12px] leading-snug transition-colors duration-200 ${
                          on ? "text-[color:var(--text-muted)] line-through" : "text-[color:var(--text)]"
                        }`}
                      >
                        {step}
                      </span>
                      <span className="mt-1 block text-[10.5px] leading-relaxed text-[color:var(--text-muted)]">
                        {noteFor(step)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-5 border-t border-[color:var(--border)]">
        {run.warnings.length > 0 ? (
          <Disclosure label="Known limitations" hint={`${run.warnings.length}`}>
            <ul className="space-y-1.5 border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-2.5">
              {run.warnings.map((w, i) => (
                <li
                  key={`${i}-${w}`}
                  className="flex gap-2 text-[11.5px] leading-relaxed text-[color:var(--st-warn)]"
                >
                  <span className="mt-[7px] h-[3px] w-[3px] shrink-0 bg-[var(--st-warn)]" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}

        <Disclosure
          label="Data sources"
          hint={`${run.dataSources.filter((s) => s.ok).length}/${run.dataSources.length} OK`}
        >
          {run.dataSources.length === 0 ? (
            <p className="text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
              No data-source status was reported for this run.
            </p>
          ) : (
            <ul className="space-y-2">
              {run.dataSources.map((s, i) => (
                <li
                  key={`${i}-${s.name}`}
                  className="flex items-start gap-2.5 border-b border-[color:var(--border-subtle)] pb-2 last:border-b-0 last:pb-0"
                >
                  <span
                    aria-hidden
                    className={`mt-[6px] h-[5px] w-[5px] shrink-0 ${
                      s.ok ? "bg-[var(--st-ok)]" : "bg-[var(--st-warn)]"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[12px] leading-tight text-[color:var(--text)]">
                        {s.name}
                      </span>
                      <span
                        className={`lbl shrink-0 ${
                          s.ok ? "text-[color:var(--st-ok)]" : "text-[color:var(--st-warn)]"
                        }`}
                      >
                        {s.ok ? "OK" : "Degraded"}
                      </span>
                    </div>
                    <div className="mt-1 text-[10.5px] leading-relaxed text-[color:var(--text-muted)]">
                      {s.detail}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Disclosure>
      </section>

      <p className="mt-6 border-t border-[color:var(--border)] pt-3 text-[10.5px] leading-relaxed text-[color:var(--text-subtle)]">
        This is a pre-feasibility screening output. It does not replace hydrogeological survey,
        water-quality testing, or licensed engineering design.
      </p>
    </div>
  );
}
