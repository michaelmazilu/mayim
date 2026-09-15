"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AquaMap } from "@/components/map/AquaMap";
import { LayerControl } from "@/components/map/LayerControl";
import { stageReached, type LayerId, type MapStage } from "@/components/map/layers";
import { SearchModule } from "@/components/search/SearchModule";
import { MissionPanel } from "@/components/analysis/MissionPanel";
import { RecommendationPanel } from "@/components/recommendation/RecommendationPanel";
import { ThemeSwitch } from "@/components/ui/ThemeSwitch";
import { PlaybackBar } from "@/components/sim/PlaybackBar";
import { useSimulationPlayback } from "@/components/sim/useSimulationPlayback";
import type { AnalysisEvent, AnalysisRun, TownRef } from "@/lib/types";

const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  // On by default: the analysis is about real ground — a borehole sited on
  // visible rooftops and tracks argues for itself in a way the same point on
  // blank cartography does not. The toggle is there for reading the vector
  // layers without imagery competing with them.
  satellite: true,
  suitability: true,
  roads: true,
  water: true,
  existing: true,
  environment: true,
  design: true,
  simulation: true,
};

/**
 * Post-analysis cinematic. Each step reveals one map layer group.
 *
 * The context steps are deliberately quick — they are scene-setting, and the
 * reader is waiting for the answer. `top3` holds longest of the build-up
 * because that is where the camera pulls back to frame all three finalists,
 * and a hold shorter than that flight makes the shot pointless.
 */
const REVEAL: { stage: MapStage; hold: number }[] = [
  { stage: "context", hold: 360 },
  { stage: "facilities", hold: 340 },
  { stage: "constraints", hold: 340 },
  { stage: "candidates", hold: 560 },
  { stage: "eliminated", hold: 460 },
  { stage: "heatmap", hold: 560 },
  { stage: "top3", hold: 1250 },
  // Long enough to actually read the card: each runner-up states its score and
  // the per-factor gap that cost it the recommendation, and two seconds is not
  // enough time to take in a sentence and look at the site it describes.
  { stage: "tour3", hold: 3800 },
  { stage: "tour2", hold: 3800 },
  { stage: "winner", hold: 2400 },
  { stage: "design", hold: 0 },
];

/**
 * With a replayable simulation the design holds long enough to be read, and
 * then the households take the map over and the ten years start to play.
 */
const SIM_REVEAL: { stage: MapStage; hold: number }[] = [
  ...REVEAL.slice(0, -1),
  { stage: "design", hold: 1500 },
  { stage: "simulation", hold: 0 },
];

/** The layer panel's footprint (16px inset + 178px + a 12px gap), which the playback dock keeps clear of. */
const LAYER_PANEL_CLEARANCE = "206px";

const PROVENANCE: Record<"live" | "cache" | "demo", { label: string; tone: string }> = {
  live: { label: "Live research", tone: "ok" },
  cache: { label: "Replayed", tone: "idle" },
  demo: { label: "Demo snapshot", tone: "idle" },
};

function DropMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-[17px] w-[17px]" aria-hidden="true">
      <path
        d="M12 2.6c0 0-7 7.6-7 11.8a7 7 0 0 0 14 0c0-4.2-7-11.8-7-11.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Page() {
  const [town, setTown] = useState<TownRef | null>(null);
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const [events, setEvents] = useState<AnalysisEvent[]>([]);
  const [stage, setStage] = useState<MapStage>("idle");
  const [running, setRunning] = useState(false);
  const [provenance, setProvenance] = useState<AnalysisRun["provenance"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<LayerId, boolean>>(DEFAULT_LAYERS);
  const [focusCandidateId, setFocusCandidateId] = useState<string | null>(null);
  const [showLayers, setShowLayers] = useState(true);
  const [showMission, setShowMission] = useState(true);
  const [showReco, setShowReco] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  useEffect(() => () => {
    clearTimers();
    abortRef.current?.abort();
  }, []);

  /** Walk the reveal sequence once results are in. */
  const playReveal = useCallback((withSimulation: boolean) => {
    clearTimers();
    let acc = 260;
    for (const step of withSimulation ? SIM_REVEAL : REVEAL) {
      timers.current.push(setTimeout(() => setStage(step.stage), acc));
      acc += step.hold;
    }
  }, []);

  const analyze = useCallback(
    async (target: TownRef, force: boolean) => {
      abortRef.current?.abort();
      clearTimers();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setTown(target);
      setRun(null);
      setEvents([]);
      setError(null);
      setProvenance(null);
      setRunning(true);
      setFocusCandidateId(null);
      setStage("town");

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ town: target, force }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Analysis request failed (${res.status})`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const nameLine = frame.split("\n").find((l) => l.startsWith("event: "));
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!nameLine || !dataLine) continue;
            const name = nameLine.slice(7).trim();
            let payload: unknown;
            try {
              payload = JSON.parse(dataLine.slice(6));
            } catch {
              continue;
            }

            if (name === "meta") {
              const m = payload as { provenance: AnalysisRun["provenance"] };
              setProvenance(m.provenance);
            } else if (name === "progress") {
              const ev = payload as AnalysisEvent;
              setEvents((prev) => [...prev, ev]);
              setStage((s) => (s === "town" ? "context" : s));
            } else if (name === "done") {
              const finished = payload as AnalysisRun;
              setRun(finished);
              setProvenance(finished.provenance);
              setRunning(false);
              playReveal(Boolean(finished.simulation?.replay));
            } else if (name === "error") {
              const e = payload as { message: string };
              setError(e.message);
              setRunning(false);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Analysis failed unexpectedly.");
      } finally {
        setRunning(false);
      }
    },
    [playReveal],
  );

  const reset = () => {
    abortRef.current?.abort();
    clearTimers();
    setTown(null);
    setRun(null);
    setEvents([]);
    setStage("idle");
    setRunning(false);
    setError(null);
    setProvenance(null);
    setFocusCandidateId(null);
  };

  const toggleLayer = (id: LayerId) =>
    setLayers((prev) => ({ ...prev, [id]: !prev[id] }));

  const prov = provenance ? PROVENANCE[provenance] : null;

  // The household simulation: one player per replay, running only while its
  // stage is on screen. The page holds the player, never its per-week state,
  // so a simulated week re-renders the playback bar and nothing else.
  const replay = run?.simulation?.replay ?? null;
  const simActive = replay !== null && stageReached(stage, "simulation") && layers.simulation;
  const player = useSimulationPlayback(replay, { active: simActive });

  return (
    <>
      {/* ---------- Rail ----------
          What is true whether or not a town is loaded: the product, the one
          destination this console has, the layer tool, and who is looking. */}
      <nav className="rail" aria-label="Primary">
        <div className="rail-head">
          <div className="rail-mark">
            <DropMark />
          </div>
        </div>

        <div className="rail-body">
          <button type="button" className="rail-btn active" data-tip="Site analysis" aria-current="page">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.6 2.7 3.9 5.7 3.9 9s-1.3 6.3-3.9 9c-2.6-2.7-3.9-5.7-3.9-9S9.4 5.7 12 3Z" />
            </svg>
          </button>

          <button
            type="button"
            className={`rail-btn ${showLayers ? "active" : ""}`}
            data-tip="Layers"
            aria-pressed={showLayers}
            disabled={!run}
            onClick={() => setShowLayers((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="m12 3 9 5-9 5-9-5 9-5Z" strokeLinejoin="round" />
              <path d="m3.5 12.5 8.5 4.7 8.5-4.7" strokeLinejoin="round" />
            </svg>
          </button>

          {/* The two reading columns are the only things competing with the map
              for width, so each gets its own switch rather than one "focus
              mode" that decides for the reader which half matters. */}
          <button
            type="button"
            className={`rail-btn ${showMission ? "active" : ""}`}
            data-tip="Analysis panel"
            aria-pressed={showMission}
            disabled={!town}
            onClick={() => setShowMission((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <rect x="3" y="4.5" width="18" height="15" rx="1" />
              <path d="M9.5 4.5v15" />
            </svg>
          </button>

          <button
            type="button"
            className={`rail-btn ${showReco ? "active" : ""}`}
            data-tip="Recommendation panel"
            aria-pressed={showReco}
            disabled={!run}
            onClick={() => setShowReco((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <rect x="3" y="4.5" width="18" height="15" rx="1" />
              <path d="M14.5 4.5v15" />
            </svg>
          </button>

          <div className="rail-spacer" />
        </div>

        <div className="rail-foot">
          <ThemeSwitch />
        </div>
      </nav>

      {/* ---------- Shell ---------- */}
      <div className="shell">
        {/* The top bar holds the current page: what it is, and the control that
            reloads it. Anything surviving navigation belongs on the rail. */}
        <header className="topbar">
          <div className="tb-crumbs">
            {town ? (
              <button type="button" className="tb-crumb" onClick={reset}>
                Mayim
              </button>
            ) : (
              <span className="tb-crumb cur">Mayim</span>
            )}
            {town && (
              <>
                <span className="tb-sep" aria-hidden="true">
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                    <path d="m4.5 2.5 3.5 3.5-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="tb-crumb cur">{town.name}</span>
              </>
            )}
          </div>

          <div className="tb-spacer" />

          <div className="flex items-center gap-3">
            {running && <span className="ch-pill live">Analysing</span>}
            {!running && prov && <span className={`ch-pill ${prov.tone}`}>{prov.label}</span>}

            {town && (
              <button
                type="button"
                className={`tb-ico ${running ? "spinning" : ""}`}
                data-tip="Re-run live research"
                aria-label="Re-run live research"
                disabled={running}
                onClick={() => void analyze(town, true)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M20 12a8 8 0 1 1-2.4-5.7" strokeLinecap="round" />
                  <path d="M20 3.5V9h-5.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}

            {town && (
              <button type="button" className="btn-ghost" onClick={reset}>
                New search
              </button>
            )}
          </div>
        </header>

        {/* ---------- View ----------
            Three docked columns separated by hairlines, not panels floating over
            the map. The map is a background; the columns are the reading. */}
        <main className="view flex">
          <AnimatePresence initial={false}>
            {town && showMission && (
              <motion.aside
                key="mission"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 320, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                className="min-w-0 shrink-0 overflow-hidden border-r border-[color:var(--border)] bg-[var(--bg-card)]"
              >
                <div className="h-full w-[320px]">
                  <MissionPanel
                    town={town}
                    events={events}
                    running={running}
                    provenance={provenance}
                    onRerun={() => void analyze(town, true)}
                  />
                </div>
              </motion.aside>
            )}
          </AnimatePresence>

          <div className="simview relative min-w-0 flex-1">
            <AquaMap
              town={town}
              run={run}
              layout={run?.layout ?? null}
              stage={stage}
              layers={layers}
              focusCandidateId={focusCandidateId}
              simulation={player}
            />

            {/* Landing */}
            {!town && (
              <div className="absolute inset-0 z-20 grid place-items-center px-6">
                <SearchModule onSelect={(t) => void analyze(t, false)} busy={running} />
              </div>
            )}

            {run && showLayers && (
              <div className="absolute bottom-4 left-4 z-20">
                <LayerControl
                  layers={layers}
                  onToggle={toggleLayer}
                  hidden={replay ? [] : ["simulation"]}
                />
              </div>
            )}

            <AnimatePresence>
              {player && simActive && (
                <motion.div
                  key="simbar"
                  className="simbar-dock"
                  style={{ "--simbar-left": showLayers ? LAYER_PANEL_CLEARANCE : "16px" } as CSSProperties}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                >
                  <PlaybackBar player={player} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence initial={false}>
            {run && showReco && (
              <motion.aside
                key="reco"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 400, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                className="min-w-0 shrink-0 overflow-hidden border-l border-[color:var(--border)] bg-[var(--bg-card)]"
              >
                <div className="h-full w-[400px]">
                  <RecommendationPanel run={run} onFocusCandidate={setFocusCandidateId} />
                </div>
              </motion.aside>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* Error toast */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16 }}
            className="toast fixed bottom-6 left-1/2 z-[300] flex max-w-[min(560px,calc(100vw-48px))] -translate-x-1/2 items-center gap-4"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 text-[color:var(--grey-4)] underline-offset-2 hover:underline"
            >
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
