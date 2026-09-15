"use client";

import type { JSX, ReactNode } from "react";
import type { AnalysisRun, InfrastructureType, SimulationProject } from "@/lib/types";
import { BEHAVIOUR } from "@/lib/config/coefficients";
import { Stat } from "@/components/ui/Stat";
import { int, usd } from "@/components/sim/format";

const SHORT_TYPE: Record<InfrastructureType, string> = {
  solar_borehole: "Solar borehole",
  borehole_rehabilitation: "Borehole rehabilitation",
  rainwater_harvesting: "Rainwater harvesting",
  filtration_and_storage: "Filtration and storage",
  community_storage_and_taps: "Storage and taps",
};

const PASS_PCT = Math.round(BEHAVIOUR.passThreshold.value * 100);

function Section(props: { title: string; aside?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="mt-6 first:mt-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="lbl">{props.title}</h3>
        {props.aside}
      </div>
      <div className="mt-2.5">{props.children}</div>
    </section>
  );
}

function held(project: SimulationProject): string {
  return project.futures ? `${project.futures.passed}/${project.futures.run}` : "—";
}

function Funnel(props: { run: AnalysisRun }): JSX.Element | null {
  const sim = props.run.simulation;
  if (!sim) return null;
  const n = (v: number): JSX.Element => <span className="num text-[color:var(--text)]">{int(v)}</span>;
  return (
    <p className="text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
      {n(sim.screened)} projects screened <span aria-hidden="true">→</span> {n(sim.detailed)} simulated
      against households <span aria-hidden="true">→</span> {n(sim.stressTested)} stress-tested ×{" "}
      {n(sim.futuresPerProject)} futures
    </p>
  );
}

export function SimulationTab(props: {
  run: AnalysisRun;
  onFocusCandidate?: (id: string | null) => void;
}): JSX.Element {
  const { run, onFocusCandidate } = props;
  const sim = run.simulation;

  if (!sim) {
    return (
      <p className="text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
        No household simulation was produced for this run.
      </p>
    );
  }

  const years = Math.max(1, Math.round(sim.weeksPerFuture / 52));
  const rec = sim.projects.find((p) => p.id === sim.recommendedId) ?? null;
  const futures = rec?.futures ?? null;

  return (
    <div>
      <section>
        <h3 className="lbl">Household simulation</h3>
        <div className="mt-2.5">
          <Funnel run={run} />
          <p className="mono num mt-1.5 text-[10.5px] text-[color:var(--text-subtle)]">
            {int(sim.householdClusters)} household clusters · {int(sim.buildings)} buildings (
            {sim.buildingSource === "local" ? "mapped" : "sampled"}) · {years} years per future
          </p>
        </div>
      </section>

      {rec ? (
        <Section title="Recommended project">
          <div className="border-l-2 border-[color:var(--accent)] pl-3">
            <div className="text-[13px] leading-snug text-[color:var(--text)]">{rec.label}</div>
            <div className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">{rec.anchor}</div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat
              label="Cost per person served"
              value={usd(rec.costPerPersonServed)}
              sub={`Whole-life cost over ${years} years`}
              accent
            />
            <Stat
              label="People served"
              value={
                futures
                  ? `${int(futures.peopleServed.p10)}–${int(futures.peopleServed.p90)}`
                  : int(rec.peopleServed)
              }
              sub={futures ? "p10–p90 across futures" : "Week zero, every source working"}
              accent
            />
            <Stat
              label="Hours saved / day"
              value={int(futures ? futures.hoursSavedPerDay.p50 : rec.hoursSavedPerDay)}
              sub={
                futures
                  ? `p10 ${int(futures.hoursSavedPerDay.p10)} · p90 ${int(futures.hoursSavedPerDay.p90)}`
                  : "Week zero"
              }
            />
            <Stat
              label="Futures held"
              value={futures ? `${futures.passed} of ${futures.run}` : "—"}
              sub={`Served ≥ ${PASS_PCT}% of design`}
            />
          </div>

          <div className="mt-2 flex items-baseline justify-between gap-3 border border-[color:var(--border)] px-3 py-2">
            <span className="lbl">Capacity</span>
            <span className="text-[12px] text-[color:var(--text)]">
              {!futures
                ? "Not stress-tested"
                : futures.capacityYear === null
                  ? `Keeps up for ${years} years`
                  : `Demand outruns it in year ${futures.capacityYear}`}
            </span>
          </div>
        </Section>
      ) : null}

      {sim.projects.length > 0 ? (
        <Section
          title="Projects compared"
          aside={<span className="lbl">{sim.projects.length}</span>}
        >
          <div className="-mx-2.5 overflow-x-auto">
            <table className="ch-table">
              <thead>
                <tr>
                  <th>System</th>
                  <th className="num">Cost / person</th>
                  <th className="num" title="People served in week zero, every source working">
                    Served
                  </th>
                  <th className="num" title={`Futures in which people served stayed at or above ${PASS_PCT}% of the design`}>
                    Held
                  </th>
                </tr>
              </thead>
              <tbody>
                {sim.projects.map((p) => {
                  const isRec = p.id === sim.recommendedId;
                  const focus = (): void => onFocusCandidate?.(p.candidateId);
                  return (
                    <tr
                      key={p.id}
                      tabIndex={0}
                      onClick={focus}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          focus();
                        }
                      }}
                      className="cursor-pointer transition-colors duration-100 hover:bg-[var(--bg-sunken)] focus:outline-none focus-visible:bg-[var(--bg-sunken)]"
                      aria-label={`${SHORT_TYPE[p.type] ?? p.label} at ${p.candidateId}${isRec ? ", recommended" : ""}`}
                    >
                      <td className="py-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={`h-[6px] w-[6px] shrink-0 ${isRec ? "bg-[var(--accent)]" : "bg-transparent"}`}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-[12px] leading-tight">
                              {SHORT_TYPE[p.type] ?? p.label}
                            </span>
                            <span className="mono block text-[10px] leading-tight text-[color:var(--text-subtle)]">
                              {p.candidateId}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td className="num mono">{usd(p.costPerPersonServed)}</td>
                      <td className="num mono">{int(p.peopleServed)}</td>
                      <td className="num mono">{held(p)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {sim.assumptions.length > 0 ? (
        <Section title="Assumptions">
          <ul className="space-y-1.5">
            {sim.assumptions.map((item, i) => (
              <li key={`${i}-${item}`} className="flex gap-2 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
                <span className="mt-[7px] h-[3px] w-[3px] shrink-0 bg-[var(--grey-4)]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
