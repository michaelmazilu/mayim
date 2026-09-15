"use client";

import { useState, type JSX } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { AnalysisRun, EvidenceCategory, EvidenceFinding, ScoreFactor } from "@/lib/types";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const CATEGORY_ORDER: EvidenceCategory[] = [
  "water_need",
  "hydrogeology",
  "infrastructure",
  "environment",
  "regulation",
];

const CATEGORY_LABEL: Record<EvidenceCategory, string> = {
  water_need: "Water need",
  hydrogeology: "Hydrogeology",
  infrastructure: "Infrastructure",
  environment: "Environment",
  regulation: "Regulation",
};

const FACTOR_LABEL: Record<ScoreFactor, string> = {
  need: "community need",
  groundwater: "groundwater feasibility",
  risk: "environmental risk",
  cost: "cost",
  access: "access",
};

export function EvidenceTab(props: {
  run: AnalysisRun;
  onFocusCandidate?: (id: string | null) => void;
}): JSX.Element {
  const { run } = props;
  const findings = run.findings;

  if (findings.length === 0) {
    return (
      <div className="border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-3">
        <div className="lbl">
          No sources retrieved
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
          No external evidence was retrieved for this run. The analysis below is derived from mapped
          geospatial data only.
        </p>
      </div>
    );
  }

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: findings.filter((f) => f.category === category),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="lbl">
          Evidence base
        </h3>
        <span className="mono text-[10px] num text-[color:var(--text-muted)]">
          {findings.length} {findings.length === 1 ? "source" : "sources"}
        </span>
      </div>

      {groups.map((group) => (
        <section key={group.category} className="mt-5">
          <div className="flex items-baseline justify-between gap-3 border-b border-[color:var(--border)] pb-1.5">
            <h4 className="lbl">
              {CATEGORY_LABEL[group.category]}
            </h4>
            <span className="mono text-[10px] num text-[color:var(--text-subtle)]">
              {group.items.length}
            </span>
          </div>

          <div className="mt-2.5 space-y-2.5">
            {group.items.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Collapsed, a finding is its title, who published it and how far it is
 * trusted — enough to judge whether to read it. The summary and the scoring
 * effect wait until it is opened, because sixteen of these expanded is a wall
 * rather than an evidence base. The category chip is gone: these are already
 * grouped under their category heading.
 */
function FindingCard(props: { finding: EvidenceFinding }): JSX.Element {
  const f = props.finding;
  const [open, setOpen] = useState(false);
  const confidence = Math.min(1, Math.max(0, f.confidence));

  return (
    <article className="border border-[color:var(--border)] bg-[var(--bg-sunken)]">
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <div className="min-w-0 flex-1">
          {f.sourceUrl ? (
            <a
              href={f.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="line-clamp-2 text-[12.5px] leading-snug text-[color:var(--text)] transition-colors duration-200 hover:text-[color:var(--accent)]"
            >
              {f.title}
            </a>
          ) : (
            <span className="line-clamp-2 text-[12.5px] leading-snug text-[color:var(--text)]">
              {f.title}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide summary" : "Show summary"}
          className={`mt-[3px] shrink-0 text-[color:var(--grey-4)] transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
        >
          <svg viewBox="0 0 10 10" className="h-[9px] w-[9px]">
            <path
              d="M3.4 1.6 6.9 5 3.4 8.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="flex items-center gap-2.5 px-3 pb-2.5 pt-1.5">
        <span className="lbl min-w-0 flex-1 truncate">
          {f.sourceName}
          {f.publishedDate ? (
            <>
              <span className="mx-1.5 text-[color:var(--text-subtle)]">·</span>
              {f.publishedDate}
            </>
          ) : null}
        </span>
        <div className="h-[3px] w-[44px] shrink-0 overflow-hidden bg-[rgba(148,163,184,0.12)]">
          <div
            className="h-full bg-[var(--text)] transition-[width] duration-500"
            style={{ width: `${confidence * 100}%` }}
          />
        </div>
        <span className="mono num shrink-0 text-[9.5px] text-[color:var(--text-muted)]">
          {Math.round(confidence * 100)}%
        </span>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="border-t border-[color:var(--border-subtle)] px-3 py-2.5">
              <p className="text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
                {f.summary}
              </p>
              {f.scoreImpact ? (
                <p className="mono mt-2 text-[9.5px] leading-snug text-[color:var(--accent)]">
                  Influences {FACTOR_LABEL[f.scoreImpact.factor]}
                  <span className="mx-1.5 text-[color:var(--text-subtle)]">·</span>
                  {f.scoreImpact.direction}
                  <span className="mx-1.5 text-[color:var(--text-subtle)]">·</span>
                  magnitude {f.scoreImpact.magnitude.toFixed(2)}
                </p>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}
