"use client";

import type { JSX } from "react";
import type { AnalysisRun, SimulationMetric, SimulationProject } from "@/lib/types";
import { Stat } from "@/components/ui/Stat";
import { Disclosure } from "@/components/ui/Disclosure";

function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function usdFine(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${Math.round(n)}`;
  return `$${int(Math.round(n / 100) * 100)}`;
}

function hours(n: number): string {
  if (n >= 100) return int(n);
  return n.toFixed(1);
}

/**
 * p10 – median – p90 as one bar. The median is a tick rather than a fill so the
 * eye reads the SPREAD first: a wide bar is a result that depends on luck, and
 * that is the thing a planner needs to see before the headline figure.
 */
function Spread(props: { metric: SimulationMetric; max: number; unit: string }): JSX.Element {
  const { metric, max, unit } = props;
  const safeMax = max > 0 ? max : 1;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / safeMax) * 100))}%`;

  return (
    <div>
      <div className="relative h-[6px] w-full bg-[var(--bg-sunken)]">
        <div
          className="absolute inset-y-0 bg-[var(--score-mid)]"
          style={{ left: pct(metric.p10), right: `calc(100% - ${pct(metric.p90)})` }}
        />
        <div
          className="absolute inset-y-[-2px] w-[2px] bg-[var(--text)]"
          style={{ left: pct(metric.p50) }}
        />
      </div>
      <div className="mono num mt-1 flex justify-between text-[10px] text-[color:var(--text-subtle)]">
        <span>{int(metric.p10)}</span>
        <span className="text-[color:var(--text)]">
          {int(metric.p50)} {unit}
        </span>
        <span>{int(metric.p90)}</span>
      </div>
    </div>
  );
}

function ProjectRow(props: {
  project: SimulationProject;
  best: number;
  isRecommended: boolean;
}): JSX.Element {
  const { project, best, isRecommended } = props;
  const served = project.futures ? project.futures.peopleServed.p50 : project.peopleServed;
  const width = best > 0 ? Math.max(2, (served / best) * 100) : 0;

  return (
    <div
      className={`border-b border-[color:var(--border-subtle)] px-3 py-2.5 last:border-b-0 ${
        isRecommended ? "bg-[var(--bg-sunken)]" : ""
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[12px] leading-tight text-[color:var(--text)]">
          {project.label}
        </span>
        <span className="mono num shrink-0 text-[11px] text-[color:var(--text)]">{int(served)}</span>
      </div>

      <div className="mt-1.5 h-[3px] w-full bg-[var(--bg-sunken)]">
        <div
          className="h-full"
          style={{
            width: `${width}%`,
            background: isRecommended ? "var(--score-high)" : "var(--score-mid)",
          }}
        />
      </div>

      <div className="mono mt-1.5 flex justify-between text-[10px] text-[color:var(--text-subtle)]">
        <span>{usdFine(project.costPerPersonServed)}/person</span>
        <span>{hours(project.hoursSavedPerDay)} h/day saved</span>
        {project.futures ? (
          <span>
            {project.futures.passed}/{project.futures.run} futures
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function SimulationTab(props: {
  run: AnalysisRun;
  onFocusCandidate?: (id: string | null) => void;
}): JSX.Element {
  const { run } = props;
  const sim = run.simulation;

  if (!sim || sim.projects.length === 0) {
    return (
      <div className="border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-3">
        <div className="lbl">No simulation for this run</div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
          The household simulation did not produce results here — usually because no candidate site
          survived the hard constraints, or the run was cached before the simulation existed. The
          figures on the other tabs come from the geospatial model alone.
        </p>
      </div>
    );
  }

  const recommended =
    sim.projects.find((p) => p.id === sim.recommendedId) ?? sim.projects[0];
  const futures = recommended.futures;
  const best = Math.max(
    ...sim.projects.map((p) => (p.futures ? p.futures.peopleServed.p50 : p.peopleServed)),
  );

  return (
    <div>
      {/* The headline is the robustness claim, not the point estimate: a result
          that only holds in half its futures is a different recommendation. */}
      <section>
        <div className="lbl">Simulated outcome</div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[color:var(--text)]">
          {int(sim.householdClusters)} household clusters from {int(sim.buildings)} mapped buildings.{" "}
          {sim.screened} placements screened, {sim.detailed} simulated in detail,{" "}
          {sim.stressTested} stress-tested across {sim.futuresPerProject} futures of{" "}
          {sim.weeksPerFuture} weeks each.
        </p>
      </section>

      <section className="mt-5">
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="People served"
            value={futures ? int(futures.peopleServed.p50) : int(recommended.peopleServed)}
            sub={futures ? "Median across futures" : "Week zero, all sources working"}
            accent
          />
          <Stat
            label="Collection time saved"
            value={`${hours(recommended.hoursSavedPerDay)} h`}
            sub="Per day, across the community"
            accent
          />
          {futures ? (
            <Stat
              label="Held in"
              value={`${futures.passed}/${futures.run}`}
              sub="Futures where it still serves"
            />
          ) : null}
          <Stat
            label="Cost per person"
            value={usdFine(recommended.costPerPersonServed)}
            sub="Lifecycle cost ÷ people served"
          />
        </div>
      </section>

      {futures ? (
        <section className="mt-5">
          <div className="lbl">People served across futures</div>
          <div className="mt-2.5">
            <Spread
              metric={futures.peopleServed}
              max={Math.max(futures.peopleServed.p90, best)}
              unit="people"
            />
          </div>

          <div className="mt-4 lbl">Hours saved per day</div>
          <div className="mt-2.5">
            <Spread
              metric={futures.hoursSavedPerDay}
              max={futures.hoursSavedPerDay.p90}
              unit="hours"
            />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Stat
              label="Weeks out of service"
              value={int(futures.weeksDown.p50)}
              sub={`${int(futures.weeksDown.p10)}–${int(futures.weeksDown.p90)} across futures`}
            />
            <Stat
              label="Demand outruns supply"
              value={futures.capacityYear === null ? "Beyond horizon" : `Year ${futures.capacityYear}`}
              sub={
                futures.capacityYear === null
                  ? "Not within the simulated period"
                  : "Median year capacity is reached"
              }
            />
          </div>
        </section>
      ) : null}

      <section className="mt-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="lbl">Placements compared</span>
          <span className="mono num text-[10px] text-[color:var(--text-subtle)]">
            {sim.projects.length}
          </span>
        </div>
        <div className="mt-2.5 border border-[color:var(--border)]">
          {sim.projects.slice(0, 8).map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              best={best}
              isRecommended={p.id === recommended.id}
            />
          ))}
        </div>
      </section>

      <section className="mt-5 border-t border-[color:var(--border)]">
        <Disclosure label="Why here" hint={recommended.type.replace(/_/g, " ")}>
          <p className="text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
            {recommended.anchor}
          </p>
        </Disclosure>

        <Disclosure label="Household data" hint={sim.buildingSource}>
          <p className="text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
            {sim.householdClusters} clusters derived from {int(sim.buildings)} buildings (
            {sim.buildingSource === "full"
              ? "every building returned for the town"
              : sim.buildingSource === "local"
                ? "a full-detail fetch around the candidate sites"
                : "a capped sample of the town's buildings"}
            ). Clusters carry household size and demand; walking times are one-way.
          </p>
        </Disclosure>

        {sim.assumptions.length > 0 ? (
          <Disclosure label="Assumptions" hint={`${sim.assumptions.length}`}>
            <ul className="space-y-1.5">
              {sim.assumptions.map((a, i) => (
                <li
                  key={`${i}-${a}`}
                  className="flex gap-2 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]"
                >
                  <span className="mt-[7px] h-[3px] w-[3px] shrink-0 bg-[var(--grey-4)]" />
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </section>
    </div>
  );
}
