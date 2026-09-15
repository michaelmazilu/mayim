"use client";

import type { JSX, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { LngLat, TownRef } from "@/lib/types";

const SHORTCUTS = ["Kisumu, Kenya", "Gulu, Uganda", "Tamale, Ghana"] as const;
const DEBOUNCE_MS = 280;
const MAX_RESULTS = 5;
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

type GeocodeResponse = { results?: TownRef[]; error?: string };
type Phase = "idle" | "loading" | "ready" | "error";

function formatCoords(center: LngLat): string {
  const [lon, lat] = center;
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}°${
    lon >= 0 ? "E" : "W"
  }`;
}

function subtitle(town: TownRef): string {
  const parts = [town.region, town.country].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(", ") : town.displayName;
}

function DropGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-[26px] w-[26px] shrink-0" aria-hidden="true">
      <path
        d="M12 2.6c0 0-7 7.6-7 11.8a7 7 0 0 0 14 0c0-4.2-7-11.8-7-11.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SearchModule(props: {
  onSelect: (town: TownRef) => void;
  busy: boolean;
}): JSX.Element {
  const { onSelect, busy } = props;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TownRef[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  /** Set by the shortcut pills so their lookup skips the debounce window. */
  const immediateRef = useRef(false);
  const prevBusyRef = useRef(busy);

  // If the parent kept us mounted through a run that ended (e.g. it failed),
  // bring the module back rather than leaving an empty screen.
  useEffect(() => {
    if (prevBusyRef.current && !busy) setDismissed(false);
    prevBusyRef.current = busy;
  }, [busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const lookup = useCallback(async (q: string): Promise<void> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    seqRef.current += 1;
    const seq = seqRef.current;

    setPhase("loading");
    setOpen(true);

    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`geocode ${res.status}`);
      const data = (await res.json()) as GeocodeResponse;
      if (seq !== seqRef.current) return;
      if (data.error) {
        setResults([]);
        setPhase("error");
        return;
      }
      setResults((data.results ?? []).slice(0, MAX_RESULTS));
      setHighlight(0);
      setPhase("ready");
    } catch {
      if (ctrl.signal.aborted || seq !== seqRef.current) return;
      setResults([]);
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    const q = query.trim();
    const immediate = immediateRef.current;
    immediateRef.current = false;
    if (q.length < 2) return;

    const timer = setTimeout(() => void lookup(q), immediate ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, lookup]);

  /** Typing below the minimum length cancels any in-flight lookup and empties the list. */
  function onQueryChange(value: string): void {
    setQuery(value);
    setOpen(true);
    if (value.trim().length < 2) {
      abortRef.current?.abort();
      seqRef.current += 1;
      setResults([]);
      setPhase("idle");
    }
  }

  const commit = useCallback(
    (town: TownRef): void => {
      abortRef.current?.abort();
      setOpen(false);
      setDismissed(true);
      onSelect(town);
    },
    [onSelect],
  );

  function runShortcut(label: string): void {
    if (busy) return;
    immediateRef.current = true;
    setQuery(label);
    setOpen(true);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (results.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => {
        const next = e.key === "ArrowDown" ? h + 1 : h - 1;
        return (next + results.length) % results.length;
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const town = open ? results[highlight] : undefined;
      if (town) commit(town);
      else if (query.trim().length >= 2) void lookup(query.trim());
    }
  }

  function onPrimary(): void {
    const town = open ? results[highlight] : undefined;
    if (town) commit(town);
    else if (query.trim().length >= 2) void lookup(query.trim());
  }

  const showDropdown = open && query.trim().length >= 2;
  const primaryDisabled = busy || query.trim().length < 2;

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          key="search-module"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.28, ease: EASE }}
          className="w-full max-w-[560px]"
        >
          <div className="mb-7 flex flex-col items-center text-center">
            <div className="flex items-center gap-2.5">
              <DropGlyph />
              <h1 className="text-[34px] font-[300] leading-none tracking-[-0.02em]">
                Mayim
              </h1>
            </div>
            <p className="muted mt-3 text-[13px]">
              Evidence-backed preliminary infrastructure planning
            </p>
          </div>

          <div className="card p-4">
            <div className="relative">
              <div className="flex items-center gap-2.5 border border-[color:var(--border)] bg-[var(--paper)] px-3 transition-colors duration-150 focus-within:border-[color:var(--accent)]">
                <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-[color:var(--text-subtle)]" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  disabled={busy}
                  onChange={(e) => onQueryChange(e.target.value)}
                  onFocus={() => setOpen(true)}
                  onKeyDown={onKeyDown}
                  placeholder="Search any town or municipality"
                  autoComplete="off"
                  spellCheck={false}
                  role="combobox"
                  aria-expanded={showDropdown}
                  aria-controls="mayim-town-results"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    showDropdown && results[highlight] ? `town-opt-${highlight}` : undefined
                  }
                  className="h-[40px] w-full bg-transparent text-[14px] outline-none disabled:text-[color:var(--text-subtle)]"
                />
                {phase === "loading" && (
                  <span className="ch-pill live shrink-0">Searching</span>
                )}
              </div>

              <AnimatePresence>
                {showDropdown && (
                  <motion.div
                    key="dropdown"
                    id="mayim-town-results"
                    role="listbox"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.16, ease: EASE }}
                    className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 border border-[color:var(--border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-pop)]"
                  >
                    {phase === "error" ? (
                      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <span className="sm muted">Search is temporarily unavailable.</span>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => void lookup(query.trim())}
                        >
                          Retry
                        </button>
                      </div>
                    ) : results.length === 0 ? (
                      <div className="sm muted px-3 py-2.5">
                        {phase === "loading"
                          ? "Searching…"
                          : "No matching towns found. Try including the country, e.g. 'Gulu, Uganda'."}
                      </div>
                    ) : (
                      <ul className="max-h-[264px] overflow-y-auto">
                        {results.map((town, i) => (
                          <li key={`${town.slug}-${i}`}>
                            <button
                              type="button"
                              id={`town-opt-${i}`}
                              role="option"
                              aria-selected={i === highlight}
                              onMouseEnter={() => setHighlight(i)}
                              onClick={() => commit(town)}
                              className={`flex w-full items-center justify-between gap-4 border-b border-[color:var(--border-subtle)] px-3 py-2.5 text-left transition-colors duration-100 last:border-b-0 ${
                                i === highlight ? "bg-[var(--bg-sunken)]" : ""
                              }`}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-[13px] leading-tight">
                                  {town.name}
                                </span>
                                <span className="sm muted mt-0.5 block truncate leading-tight">
                                  {subtitle(town)}
                                </span>
                              </span>
                              <span className="mono num shrink-0 text-[11px] text-[color:var(--text-subtle)]">
                                {formatCoords(town.center)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <button
              type="button"
              onClick={onPrimary}
              disabled={primaryDisabled}
              className="btn-primary relative mt-2.5 h-[40px] w-full overflow-hidden"
            >
              Design water infrastructure
              {busy && (
                <span className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-black/25">
                  <motion.span
                    className="absolute inset-y-0 w-1/3 bg-white/85"
                    initial={{ x: "-100%" }}
                    animate={{ x: "300%" }}
                    transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                  />
                </span>
              )}
            </button>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="lbl mr-1">Try</span>
              {SHORTCUTS.map((label) => (
                <button
                  key={label}
                  type="button"
                  disabled={busy}
                  onClick={() => runShortcut(label)}
                  className="tag hover:border-[color:var(--grey-4)] hover:text-[color:var(--text)] disabled:opacity-45"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <p className="sm muted mt-4 text-center leading-relaxed">
            For pre-feasibility analysis; field surveys and licensed engineering remain required.
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
