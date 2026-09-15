"use client";

import type { JSX, ReactNode } from "react";
import type { AnalysisRun } from "@/lib/types";
import { Stat } from "@/components/ui/Stat";

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

function litreRange(low: number, high: number): string {
  return `${int(roundLoose(low))}–${int(roundLoose(high))} L`;
}

function Section(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="lbl">
        {props.title}
      </h3>
      <div className="mt-2.5">{props.children}</div>
    </section>
  );
}

function Bullets(props: { items: string[] }): JSX.Element {
  return (
    <ul className="space-y-1.5">
      {props.items.map((item, i) => (
        <li key={`${i}-${item}`} className="flex gap-2 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
          <span className="mt-[7px] h-[3px] w-[3px] shrink-0 bg-[var(--grey-4)]" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
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

  return (
    <div>
      {/* Narrative */}
      <section>
        <div className="flex items-center gap-2">
          <span className="border border-[color:var(--accent)] bg-[rgba(14,165,233,0.08)] px-1.5 py-0.5 lbl">
            {run.narrativeSource === "llm" ? "AI-written" : "Deterministic"}
          </span>
          <span className="lbl">
            Summary
          </span>
        </div>
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-[color:var(--text)]">{run.narrative}</p>
      </section>

      {/* Headline figures */}
      <Section title="Planning figures">
        <div className="grid grid-cols-2 gap-2">
          {cost ? (
            <Stat
              label="Preliminary cost"
              value={usdRange(cost.totalLow, cost.totalHigh)}
              sub={`${cost.currency} · order-of-magnitude range`}
              accent
            />
          ) : null}
          {output ? (
            <Stat
              label="Daily output"
              value={litreRange(output.dailyLitersLow, output.dailyLitersHigh)}
              sub="Per day, all-in efficiency applied"
            />
          ) : null}
          {/*
            Two distinct figures, deliberately not conflated: what this system
            can supply, and how many people live in range of it.
          */}
          {rec ? (
            <Stat
              label="People served"
              value={`${int(rec.peopleServedLow)}–${int(rec.peopleServedHigh)}`}
              sub="Limited by sustainable yield"
              accent
            />
          ) : (
            <Stat
              label="People served"
              value={`${int(pop.rangeLow)}–${int(pop.rangeHigh)}`}
              sub={`Point estimate ${int(pop.peopleServed)}`}
            />
          )}
          <Stat
            label="Within service radius"
            value={`${int(pop.rangeLow)}–${int(pop.rangeHigh)}`}
            sub={`Residents inside ${int(pop.serviceRadiusM)} m`}
          />
          {rec ? (
            <Stat
              label="Maintenance"
              value={MAINTENANCE_LABEL[rec.maintenanceComplexity]}
              sub="Operational complexity"
            />
          ) : null}
          {rec ? (
            <Stat
              label="Implementation"
              value={`${rec.implementationRangeWeeks[0]}–${rec.implementationRangeWeeks[1]} weeks`}
              sub="Mobilisation to commissioning"
            />
          ) : null}
          {rec ? (
            <Stat
              label="Confidence"
              value={`${Math.round(rec.confidence * 100)}%`}
              sub="In this recommendation"
            />
          ) : null}
        </div>
      </Section>

      {rec ? (
        <div className="mt-3 border-l-2 border-[color:var(--accent)] bg-[var(--bg-sunken)] py-2 pl-3 pr-3 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
          {rec.coverageNote}
        </div>
      ) : null}

      {!rec ? (
        <div className="mt-6 border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-3 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
          No infrastructure recommendation was produced for this run — every candidate site was
          removed by a hard constraint, so no cost, output or component model was built.
        </div>
      ) : null}

      {/* Cost breakdown */}
      {cost ? (
        <Section title="Cost breakdown">
          <div className="border border-[color:var(--border)] bg-[var(--bg-sunken)]">
            {cost.lineItems.map((li, i) => (
              <div
                key={`${i}-${li.label}`}
                className="border-b border-[color:var(--border-subtle)] px-3 py-2.5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] leading-tight text-[color:var(--text)]">{li.label}</span>
                  <span className="shrink-0 whitespace-nowrap mono text-[11px] num text-[color:var(--text)]">
                    {usdRange(li.low, li.high)}
                  </span>
                </div>
                <div className="mt-1 mono text-[10.5px] leading-snug text-[color:var(--text-muted)]">
                  {li.formula}
                </div>
                <div className="mt-1 text-[10px] leading-snug text-[color:var(--text-subtle)]">{li.source}</div>
              </div>
            ))}

            <div className="flex items-baseline justify-between gap-3 border-b border-[color:var(--border-subtle)] px-3 py-2.5">
              <span className="lbl">
                Subtotal
              </span>
              <span className="shrink-0 whitespace-nowrap mono text-[11px] num text-[color:var(--text)]">
                {usdRange(cost.subtotalLow, cost.subtotalHigh)}
              </span>
            </div>

            <div className="border-b border-[color:var(--border-subtle)] px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[12px] leading-tight text-[color:var(--text)]">Access multiplier</span>
                <span className="shrink-0 mono text-[11px] num text-[color:var(--text)]">
                  ×{cost.accessMultiplier.toFixed(2)}
                </span>
              </div>
              <div className="mt-1 text-[10.5px] leading-snug text-[color:var(--text-muted)]">
                {cost.accessMultiplierReason}
              </div>
            </div>

            <div className="flex items-baseline justify-between gap-3 px-3 py-3">
              <span className="lbl">
                Total
              </span>
              <span className="shrink-0 whitespace-nowrap mono text-[13px] font-[400] num text-[color:var(--accent)]">
                {usdRange(cost.totalLow, cost.totalHigh)}
              </span>
            </div>
          </div>

          {cost.assumptions.length > 0 ? (
            <div className="mt-2.5">
              <Bullets items={cost.assumptions} />
            </div>
          ) : null}
        </Section>
      ) : null}

      {/* Water output */}
      {output ? (
        <Section title="Water output">
          <div className="border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-2.5 mono text-[10.5px] leading-relaxed text-[color:var(--text)]">
            {output.formula}
          </div>

          <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {[
              { k: "Pump rate", v: `${int(output.pumpRateLitersPerHour)} L/h` },
              { k: "Pumping hours", v: `${output.effectivePumpingHours.toFixed(1)} h/day` },
              { k: "Efficiency", v: `${Math.round(output.operationalEfficiency * 100)}%` },
              { k: "Per person", v: `${int(output.litersPerPersonPerDay)} L/day` },
              {
                k: "Daily output",
                v: litreRange(output.dailyLitersLow, output.dailyLitersHigh),
              },
              {
                k: "Supports",
                v: `${int(output.peopleSupportedLow)}–${int(output.peopleSupportedHigh)} people`,
              },
            ].map((row) => (
              <div key={row.k} className="flex items-baseline justify-between gap-2">
                <dt className="lbl">
                  {row.k}
                </dt>
                <dd className="shrink-0 whitespace-nowrap mono text-[11px] num text-[color:var(--text)]">
                  {row.v}
                </dd>
              </div>
            ))}
          </dl>

          {output.caveats.length > 0 ? (
            <div className="mt-2.5">
              <Bullets items={output.caveats} />
            </div>
          ) : null}
        </Section>
      ) : null}

      {/* Population method */}
      <Section title="Population method">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] leading-tight text-[color:var(--text)]">{pop.methodLabel}</span>
          <span className="shrink-0 lbl">
            {Math.round(pop.confidence * 100)}% conf
          </span>
        </div>
        {pop.limitations.length > 0 ? (
          <div className="mt-2">
            <Bullets items={pop.limitations} />
          </div>
        ) : null}
      </Section>

      {/* Components */}
      {rec && rec.components.length > 0 ? (
        <Section title="Components">
          <div className="space-y-2">
            {rec.components.map((c, i) => (
              <div
                key={`${i}-${c.name}`}
                className="border border-[color:var(--border)] px-3 py-2"
              >
                <div className="text-[12px] leading-tight text-[color:var(--text)]">{c.name}</div>
                <div className="mt-1 text-[11px] leading-snug text-[color:var(--text-muted)]">{c.detail}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Assumptions */}
      {rec && rec.assumptions.length > 0 ? (
        <Section title="Assumptions">
          <Bullets items={rec.assumptions} />
        </Section>
      ) : null}
    </div>
  );
}
