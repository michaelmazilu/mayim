"use client";

import type { JSX, ReactNode } from "react";
import type { AnalysisRun } from "@/lib/types";
import { Stat } from "@/components/ui/Stat";
import { Disclosure } from "@/components/ui/Disclosure";

const MAINTENANCE_LABEL: Record<"low" | "moderate" | "high", string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
};

function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Display-only rounding so a planning estimate never reads as a quotation. */
function roundLoose(n: number): number {
  const a = Math.abs(n);
  if (a >= 10000) return Math.round(n / 1000) * 1000;
  if (a >= 1000) return Math.round(n / 100) * 100;
  return Math.round(n / 10) * 10;
}

function usd(n: number): string {
  return `$${int(roundLoose(n))}`;
}

function usdRange(low: number, high: number): string {
  return `${usd(low)}–${usd(high)}`;
}

/**
 * Per-person figures land in single dollars, where the loose rounding used for
 * project totals would collapse them to $0.
 */
function usdFine(n: number): string {
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${Math.round(n)}`;
  return usd(n);
}

function litreRange(low: number, high: number): string {
  return `${int(roundLoose(low))}–${int(roundLoose(high))} L`;
}

function Bullets(props: { items: string[] }): JSX.Element {
  return (
    <ul className="space-y-1.5">
      {props.items.map((item, i) => (
        <li
          key={`${i}-${item}`}
          className="flex gap-2 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]"
        >
          <span className="mt-[7px] h-[3px] w-[3px] shrink-0 bg-[var(--grey-4)]" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Rows(props: { rows: { k: string; v: string }[] }): JSX.Element {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      {props.rows.map((row) => (
        <div key={row.k} className="flex items-baseline justify-between gap-2">
          <dt className="lbl">{row.k}</dt>
          <dd className="mono num shrink-0 whitespace-nowrap text-[11px] text-[color:var(--text)]">
            {row.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Note(props: { children: ReactNode }): JSX.Element {
  return (
    <div className="border-l-2 border-[color:var(--accent)] bg-[var(--bg-sunken)] py-2 pl-3 pr-3 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
      {props.children}
    </div>
  );
}

export function OverviewTab(props: {
  run: AnalysisRun;
  onFocusCandidate?: (id: string | null) => void;
}): JSX.Element {
  const { run } = props;
  const rec = run.recommendation;
  const pop = run.population;
  const cost = rec?.cost ?? null;
  const output = rec?.output ?? null;

  /* Widest-to-narrowest: cheapest case is the low total spread over the most
     people, dearest is the high total over the fewest. */
  const perPerson =
    cost && rec && rec.peopleServedLow > 0 && rec.peopleServedHigh > 0
      ? {
          low: cost.totalLow / rec.peopleServedHigh,
          high: cost.totalHigh / rec.peopleServedLow,
        }
      : null;

  return (
    <div>
      {/* Summary */}
      <section>
        <div className="flex items-center gap-2">
          <span className="lbl border border-[color:var(--accent)] bg-[rgba(14,165,233,0.08)] px-1.5 py-0.5">
            {run.narrativeSource === "llm" ? "AI-written" : "Deterministic"}
          </span>
          <span className="lbl">Summary</span>
        </div>
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-[color:var(--text)]">
          {run.narrative}
        </p>
      </section>

      {/* The three figures this screen exists to deliver. */}
      {rec ? (
        <section className="mt-5">
          <div className="grid grid-cols-2 gap-2">
            {cost ? (
              <Stat
                label="Preliminary cost"
                value={usdRange(cost.totalLow, cost.totalHigh)}
                sub="Order-of-magnitude"
                accent
              />
            ) : null}
            <Stat
              label="People served"
              value={`${int(rec.peopleServedLow)}–${int(rec.peopleServedHigh)}`}
              sub="Limited by sustainable yield"
              accent
            />
          </div>

          {perPerson ? (
            <div className="mt-2">
              <Stat
                label="Cost per person served"
                value={`${usdFine(perPerson.low)}–${usdFine(perPerson.high)}`}
                sub="Capital cost ÷ people served"
                accent
              />
            </div>
          ) : null}

          <div className="mt-2 grid grid-cols-2 gap-2">
            {output ? (
              <Stat
                label="Daily output"
                value={litreRange(output.dailyLitersLow, output.dailyLitersHigh)}
                sub="All-in efficiency applied"
              />
            ) : null}
            <Stat
              label="Implementation"
              value={`${rec.implementationRangeWeeks[0]}–${rec.implementationRangeWeeks[1]} wks`}
              sub="Mobilisation to commissioning"
            />
          </div>

          <div className="mt-3">
            <Note>{rec.coverageNote}</Note>
          </div>
        </section>
      ) : (
        <div className="mt-6 border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-3 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
          No infrastructure recommendation was produced for this run — every candidate site was
          removed by a hard constraint, so no cost, output or component model was built.
        </div>
      )}

      {/* Everything below is supporting detail, and stays shut until asked. */}
      <section className="mt-5 border-t border-[color:var(--border)]">
        {cost ? (
          <Disclosure label="Cost breakdown" hint={usdRange(cost.totalLow, cost.totalHigh)}>
            <div className="border border-[color:var(--border)] bg-[var(--bg-sunken)]">
              {cost.lineItems.map((li, i) => (
                <div
                  key={`${i}-${li.label}`}
                  className="border-b border-[color:var(--border-subtle)] px-3 py-2.5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[12px] leading-tight text-[color:var(--text)]">
                      {li.label}
                    </span>
                    <span className="mono num shrink-0 whitespace-nowrap text-[11px] text-[color:var(--text)]">
                      {usdRange(li.low, li.high)}
                    </span>
                  </div>
                  <div className="mono mt-1 text-[10.5px] leading-snug text-[color:var(--text-muted)]">
                    {li.formula}
                  </div>
                  <div className="mt-1 text-[10px] leading-snug text-[color:var(--text-subtle)]">
                    {li.source}
                  </div>
                </div>
              ))}

              <div className="flex items-baseline justify-between gap-3 border-b border-[color:var(--border-subtle)] px-3 py-2.5">
                <span className="lbl">Subtotal</span>
                <span className="mono num shrink-0 whitespace-nowrap text-[11px] text-[color:var(--text)]">
                  {usdRange(cost.subtotalLow, cost.subtotalHigh)}
                </span>
              </div>

              <div className="border-b border-[color:var(--border-subtle)] px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] leading-tight text-[color:var(--text)]">
                    Access multiplier
                  </span>
                  <span className="mono num shrink-0 text-[11px] text-[color:var(--text)]">
                    ×{cost.accessMultiplier.toFixed(2)}
                  </span>
                </div>
                <div className="mt-1 text-[10.5px] leading-snug text-[color:var(--text-muted)]">
                  {cost.accessMultiplierReason}
                </div>
              </div>

              <div className="flex items-baseline justify-between gap-3 px-3 py-3">
                <span className="lbl">Total</span>
                <span className="mono num shrink-0 whitespace-nowrap text-[13px] font-[400] text-[color:var(--accent)]">
                  {usdRange(cost.totalLow, cost.totalHigh)}
                </span>
              </div>
            </div>

            {cost.assumptions.length > 0 ? (
              <div className="mt-2.5">
                <Bullets items={cost.assumptions} />
              </div>
            ) : null}
          </Disclosure>
        ) : null}

        {output ? (
          <Disclosure
            label="Water output"
            hint={litreRange(output.dailyLitersLow, output.dailyLitersHigh)}
          >
            <div className="mono border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-2.5 text-[10.5px] leading-relaxed text-[color:var(--text)]">
              {output.formula}
            </div>

            <div className="mt-2.5">
              <Rows
                rows={[
                  { k: "Pump rate", v: `${int(output.pumpRateLitersPerHour)} L/h` },
                  { k: "Pumping hours", v: `${output.effectivePumpingHours.toFixed(1)} h/day` },
                  { k: "Efficiency", v: `${Math.round(output.operationalEfficiency * 100)}%` },
                  { k: "Per person", v: `${int(output.litersPerPersonPerDay)} L/day` },
                  {
                    k: "Supports",
                    v: `${int(output.peopleSupportedLow)}–${int(output.peopleSupportedHigh)}`,
                  },
                ]}
              />
            </div>

            {output.caveats.length > 0 ? (
              <div className="mt-2.5">
                <Bullets items={output.caveats} />
              </div>
            ) : null}
          </Disclosure>
        ) : null}

        <Disclosure label="Population method" hint={`${int(pop.serviceRadiusM)} m radius`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] leading-tight text-[color:var(--text)]">
              {pop.methodLabel}
            </span>
            <span className="lbl shrink-0">{Math.round(pop.confidence * 100)}% conf</span>
          </div>
          <div className="mt-2">
            <Rows
              rows={[
                { k: "Within radius", v: `${int(pop.rangeLow)}–${int(pop.rangeHigh)}` },
                { k: "Point estimate", v: int(pop.peopleServed) },
              ]}
            />
          </div>
          {pop.limitations.length > 0 ? (
            <div className="mt-2.5">
              <Bullets items={pop.limitations} />
            </div>
          ) : null}
        </Disclosure>

        {rec && rec.components.length > 0 ? (
          <Disclosure
            label="Components"
            hint={`${rec.components.length} · ${MAINTENANCE_LABEL[rec.maintenanceComplexity]} maint.`}
          >
            <div className="space-y-2">
              {rec.components.map((c, i) => (
                <div key={`${i}-${c.name}`} className="border border-[color:var(--border)] px-3 py-2">
                  <div className="text-[12px] leading-tight text-[color:var(--text)]">{c.name}</div>
                  <div className="mt-1 text-[11px] leading-snug text-[color:var(--text-muted)]">
                    {c.detail}
                  </div>
                </div>
              ))}
            </div>
          </Disclosure>
        ) : null}

        {rec && rec.assumptions.length > 0 ? (
          <Disclosure label="Assumptions" hint={`${Math.round(rec.confidence * 100)}% confidence`}>
            <Bullets items={rec.assumptions} />
          </Disclosure>
        ) : null}
      </section>
    </div>
  );
}
