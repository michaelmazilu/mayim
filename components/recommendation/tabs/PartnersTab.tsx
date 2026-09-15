"use client";

import { useCallback, useEffect, useState, type JSX } from "react";
import type { AnalysisRun, Partner, PartnerFocus } from "@/lib/types";

const FOCUS_LABEL: Record<PartnerFocus, string> = {
  boreholes: "Boreholes",
  handpumps: "Handpumps",
  solar_pumping: "Solar pumping",
  piped_schemes: "Piped schemes",
  rainwater: "Rainwater",
  water_quality: "Water quality",
  maintenance: "Maintenance",
  sanitation: "Sanitation",
  funding: "Funding",
  policy: "Policy",
  emergency: "Emergency",
};

type CopyState = "idle" | "working" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = {
  idle: "Copy project brief",
  working: "Building brief…",
  copied: "Copied to clipboard",
  failed: "Could not copy — try again",
};

function PartnerRow(props: { partner: Partner }): JSX.Element {
  const p = props.partner;
  const href = p.countryUrl ?? p.url;

  return (
    <div className="border-b border-[color:var(--border-subtle)] px-3 py-2.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-[12.5px] leading-snug text-[color:var(--text)] transition-colors duration-200 hover:text-[color:var(--accent)]"
        >
          {p.name}
        </a>
        {/* "Verified" is a real claim — a human checked the URL — so it is the
            only badge that gets emphasis. Search hits are unreviewed. */}
        <span
          className={`lbl shrink-0 ${
            p.source === "verified"
              ? "text-[color:var(--st-ok)]"
              : "text-[color:var(--text-subtle)]"
          }`}
        >
          {p.source === "verified" ? "Verified" : "Search"}
        </span>
      </div>

      <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--text-muted)]">
        {p.description}
      </p>

      {p.focus.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {p.focus.slice(0, 4).map((f) => (
            <span key={f} className="ch-pill plain">
              {FOCUS_LABEL[f]}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function PartnersTab(props: {
  run: AnalysisRun;
  onFocusCandidate?: (id: string | null) => void;
}): JSX.Element {
  const { run } = props;
  const [copy, setCopy] = useState<CopyState>("idle");

  /* Runs cached before partners existed carry none, so fall back to the
     endpoint rather than showing an empty tab for an old snapshot. `null` is
     "not fetched yet" — the loading flag is derived from it rather than set
     alongside the fetch, so nothing sets state synchronously in the effect. */
  const embedded = run.partners ?? [];
  const needsRemote = embedded.length === 0;
  const [remote, setRemote] = useState<Partner[] | null>(null);
  const country = run.town.country ?? "";

  useEffect(() => {
    if (!needsRemote) return;
    let live = true;
    fetch(`/api/partners?country=${encodeURIComponent(country)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { partners?: Partner[] } | null) => {
        if (live) setRemote(data?.partners ?? []);
      })
      .catch(() => {
        if (live) setRemote([]);
      });
    return () => {
      live = false;
    };
  }, [needsRemote, country]);

  const partners = needsRemote ? (remote ?? []) : embedded;
  const loading = needsRemote && remote === null;

  const copyBrief = useCallback(async () => {
    setCopy("working");
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run }),
      });
      if (!res.ok) throw new Error(`Brief request failed (${res.status})`);
      await navigator.clipboard.writeText(await res.text());
      setCopy("copied");
      window.setTimeout(() => setCopy("idle"), 2500);
    } catch {
      setCopy("failed");
      window.setTimeout(() => setCopy("idle"), 3000);
    }
  }, [run]);

  const verified = partners.filter((p) => p.source === "verified");
  const found = partners.filter((p) => p.source === "search");

  return (
    <div>
      <section>
        <div className="lbl">Take this to</div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[color:var(--text)]">
          Organisations working on water infrastructure in{" "}
          {run.town.country ?? "this country"}. The brief below carries the site, the costed design,
          the evidence and the simulated outcome in one markdown document.
        </p>

        <button
          type="button"
          onClick={() => void copyBrief()}
          disabled={copy === "working"}
          className="btn-ghost mt-3 h-[32px] w-full"
        >
          {COPY_LABEL[copy]}
        </button>
      </section>

      {loading && partners.length === 0 ? (
        <p className="mt-5 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
          Looking up organisations…
        </p>
      ) : null}

      {verified.length > 0 ? (
        <section className="mt-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="lbl">Verified</span>
            <span className="mono num text-[10px] text-[color:var(--text-subtle)]">
              {verified.length}
            </span>
          </div>
          <div className="mt-2 border border-[color:var(--border)]">
            {verified.map((p) => (
              <PartnerRow key={p.id} partner={p} />
            ))}
          </div>
        </section>
      ) : null}

      {found.length > 0 ? (
        <section className="mt-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="lbl">Found by search</span>
            <span className="mono num text-[10px] text-[color:var(--text-subtle)]">
              {found.length}
            </span>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-[color:var(--text-subtle)]">
            Surfaced by live search this run and not reviewed by hand — check before approaching.
          </p>
          <div className="mt-2 border border-[color:var(--border)]">
            {found.map((p) => (
              <PartnerRow key={p.id} partner={p} />
            ))}
          </div>
        </section>
      ) : null}

      {!loading && partners.length === 0 ? (
        <div className="mt-5 border border-[color:var(--border)] bg-[var(--bg-sunken)] px-3 py-3 text-[11.5px] leading-relaxed text-[color:var(--text-muted)]">
          No organisations were found for {run.town.country ?? "this country"}. The brief can still
          be copied and sent on manually.
        </div>
      ) : null}
    </div>
  );
}
