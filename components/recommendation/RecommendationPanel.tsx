"use client";

import { useRef, useState, type JSX } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { AnalysisRun } from "@/lib/types";
import { OverviewTab } from "./tabs/OverviewTab";
import { SimulationTab } from "./tabs/SimulationTab";
import { WhyTab } from "./tabs/WhyTab";
import { AlternativesTab } from "./tabs/AlternativesTab";
import { EvidenceTab } from "./tabs/EvidenceTab";
import { ValidationTab } from "./tabs/ValidationTab";
import { PartnersTab } from "./tabs/PartnersTab";

type TabId =
  | "overview"
  | "simulation"
  | "why"
  | "alternatives"
  | "evidence"
  | "validation"
  | "partners";

type TabProps = { run: AnalysisRun; onFocusCandidate?: (id: string | null) => void };

const TABS: { id: TabId; label: string; Body: (props: TabProps) => JSX.Element }[] = [
  { id: "overview", label: "Overview", Body: OverviewTab },
  // Second, not last: the simulation is the argument for the recommendation,
  // and a reader who stops after two tabs should have seen it.
  { id: "simulation", label: "Simulation", Body: SimulationTab },
  { id: "why", label: "Why this site", Body: WhyTab },
  { id: "alternatives", label: "Alternatives", Body: AlternativesTab },
  { id: "evidence", label: "Evidence", Body: EvidenceTab },
  { id: "validation", label: "Validation", Body: ValidationTab },
  { id: "partners", label: "Partners", Body: PartnersTab },
];

export function RecommendationPanel(props: {
  run: AnalysisRun;
  onFocusCandidate: (id: string | null) => void;
}): JSX.Element {
  const { run, onFocusCandidate } = props;
  const [active, setActive] = useState<TabId>("overview");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const selectTab = (id: TabId) => {
    setActive(id);
    bodyRef.current?.scrollTo({ top: 0 });
  };

  const winner = run.candidates.find((c) => c.id === run.winnerId) ?? null;
  const overall = winner ? Math.min(1, Math.max(0, winner.score.overall)) : 0;
  const lon = winner ? winner.lon : run.town.center[0];
  const lat = winner ? winner.lat : run.town.center[1];
  const title = run.recommendation?.label ?? "No viable site identified";

  // The simulation tab only exists for runs that carry a simulation.
  const tabs = TABS.filter((t) => t.id !== "simulation" || run.simulation);
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const Body = current.Body;

  return (
    <section aria-label="Recommended intervention" className="flex h-full w-full flex-col">
      {/* Header. The score is the one figure on this screen big enough to be
          found before anything else, so it is a figure and not a dial. */}
      <header className="shrink-0 border-b border-[color:var(--border-subtle)] px-4 py-3">
        <div className="lbl">Recommended intervention</div>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[16px] font-[400] leading-[1.25]">{title}</h2>
            <div className="mono num mt-1.5 text-[11px] text-[color:var(--text-subtle)]">
              {lat.toFixed(6)}
              <span className="mx-1.5">/</span>
              {lon.toFixed(6)}
            </div>
          </div>

          <div className="shrink-0 text-right">
            <div className="num text-[34px] font-[300] leading-none tracking-[-0.02em]">
              {overall.toFixed(2)}
            </div>
            <div className="lbl mt-1.5">Suitability</div>
          </div>
        </div>

        {/* The score as a rule under it: same reading, at a glance. */}
        <div className="mt-3 h-[3px] w-full overflow-hidden bg-[var(--bg-sunken)]">
          <motion.div
            className="h-full bg-[var(--text)]"
            initial={{ width: 0 }}
            animate={{ width: `${overall * 100}%` }}
            transition={{ duration: 0.7, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>
      </header>

      {/* Tabs */}
      <nav
        aria-label="Recommendation sections"
        className="flex shrink-0 gap-0 overflow-x-auto border-b border-[color:var(--border)] px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === current.id;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => selectTab(tab.id)}
              className={`relative shrink-0 whitespace-nowrap border-b-2 px-2.5 pb-2 pt-2 text-[12px] transition-colors duration-100 ${
                isActive
                  ? "border-[color:var(--accent)] text-[color:var(--text)]"
                  : "border-transparent text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
              }`}
              style={isActive ? { fontWeight: 400, marginBottom: -1 } : { marginBottom: -1 }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* Body */}
      <div ref={bodyRef} className="panel-scroll min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={active}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="px-4 py-4"
          >
            <Body run={run} onFocusCandidate={onFocusCandidate} />
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}
