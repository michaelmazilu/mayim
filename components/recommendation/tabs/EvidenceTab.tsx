"use client";

import type { JSX } from "react";
import type { AnalysisRun, EvidenceCategory, EvidenceFinding, ScoreFactor } from "@/lib/types";

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

function FindingCard(props: { finding: EvidenceFinding }): JSX.Element {
  const f = props.finding;
  const confidence = Math.min(1, Math.max(0, f.confidence));

  return (
    <article className="border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-2.5">
      {f.sourceUrl ? (
        <a
          href={f.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[12.5px] font-[400] leading-snug text-[color:var(--text)] transition-colors duration-200 hover:text-[color:var(--accent)]"
        >
          {f.title}
        </a>
      ) : (
        <span className="text-[12.5px] font-[400] leading-snug text-[color:var(--text)]">{f.title}</span>
      )}

      <div className="mt-1.5 lbl">
        {f.sourceName}
        {f.publishedDate ? (
          <>
            <span className="mx-1.5 text-[color:var(--text-subtle)]">·</span>
            {f.publishedDate}
          </>
        ) : null}
      </div>

      <p className="mt-2 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">{f.summary}</p>

      {f.scoreImpact ? (
        <p className="mt-2 mono text-[9.5px] leading-snug text-[color:var(--accent)]">
          Influences {FACTOR_LABEL[f.scoreImpact.factor]}
          <span className="mx-1.5 text-[color:var(--text-subtle)]">·</span>
          {f.scoreImpact.direction}
          <span className="mx-1.5 text-[color:var(--text-subtle)]">·</span>
          magnitude {f.scoreImpact.magnitude.toFixed(2)}
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2.5">
        <span className="shrink-0 border border-[color:var(--border)] px-1.5 py-0.5 lbl">
          {CATEGORY_LABEL[f.category]}
        </span>
        <div className="h-[3px] flex-1 overflow-hidden bg-[rgba(148,163,184,0.12)]">
          <div
            className="h-full bg-[var(--text)] transition-[width] duration-500"
            style={{ width: `${confidence * 100}%` }}
          />
        </div>
        <span className="shrink-0 mono text-[9.5px] num text-[color:var(--text-muted)]">
          {Math.round(confidence * 100)}%
        </span>
      </div>
    </article>
  );
}
