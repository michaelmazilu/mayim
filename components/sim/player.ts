/**
 * The playback engine behind the household-simulation replay.
 *
 * An external store rather than React state, because it runs at two rates that
 * React should never see: the engine steps on every animation frame, the map
 * redraws at most ~15 times a second, and React is told at most 10 times a
 * second. A week is 0.03 ms of work for a few hundred clusters, so every
 * transport action (seek, restart, another future) is done by re-simulating
 * from the seed instead of by storing states: a future is deterministic, so
 * week 212 of seed 7 is always the same week 212.
 */
import type { SimulationReplay } from "@/lib/types";
import { Future, WEEKS_PER_YEAR, type FutureFrame } from "@/lib/popsim/engine";
import { replayStats } from "./replayStats";
import type {
  PlaybackSnapshot,
  PlaybackTrace,
  ReplayStats,
  SimFrameView,
  SimMode,
  SimulationFeed,
} from "./types";

/** Ten simulated years play in about twelve seconds. */
const PLAY_SECONDS = 12;
const MAP_INTERVAL_MS = 1000 / 15;
const UI_INTERVAL_MS = 100;
/** A long frame (a background tab, a GC pause) must not leap a year ahead. */
const MAX_FRAME_S = 0.1;

type FrameListener = (view: SimFrameView) => void;

const EMPTY_TRACE: PlaybackTrace = { served: [], down: [] };

export class SimPlayer implements SimulationFeed {
  readonly replay: SimulationReplay;
  readonly stats: ReplayStats;

  private readonly weeks: number;
  private readonly weeksPerSecond: number;
  private readonly futureCount: number;
  private future: Future;
  private frame: FutureFrame | null = null;
  private futureIndex = 0;
  /** Bumped on every new Future, so listeners can tell a new future from a new week. */
  private generation = 0;
  private mode: SimMode = "project";

  private playing = false;
  private primed = false;
  private reducedMotion = false;
  private resumeOnAttach = false;
  private failed = false;

  private raf = 0;
  private lastTs = 0;
  private acc = 0;
  private lastMapEmit = -Infinity;
  private lastUiEmit = -Infinity;
  private mapWeek = -1;

  private readonly servedHist: Float64Array;
  private readonly downHist: Uint8Array;
  private known = 0;
  private trace: PlaybackTrace = EMPTY_TRACE;
  private traceKnown = -1;
  private traceGeneration = -1;

  private readonly frameListeners = new Set<FrameListener>();
  private readonly uiListeners = new Set<() => void>();
  private snapshot: PlaybackSnapshot;

  constructor(replay: SimulationReplay) {
    this.replay = replay;
    this.stats = replayStats(replay);
    this.weeks = Math.max(1, Math.round(replay.weeks));
    this.weeksPerSecond = this.weeks / PLAY_SECONDS;
    this.futureCount = Math.max(1, replay.seeds.length);
    this.servedHist = new Float64Array(this.weeks);
    this.downHist = new Uint8Array(this.weeks);
    this.future = new Future(replay, this.seedFor(0));
    this.snapshot = this.buildSnapshot();
  }

  // ---------------------------------------------------------------------------
  // Stores
  // ---------------------------------------------------------------------------

  /** React: useSyncExternalStore(subscribe, getSnapshot). Both are bound, so their identity is stable. */
  subscribe = (listener: () => void): (() => void) => {
    this.uiListeners.add(listener);
    return () => {
      this.uiListeners.delete(listener);
    };
  };

  getSnapshot = (): PlaybackSnapshot => this.snapshot;

  subscribeFrames(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  peekFrame(): SimFrameView | null {
    return this.view();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * The simulation stage is on screen. The first attach auto-plays once, or,
   * when the reader has asked for reduced motion, shows the final week; a later
   * attach resumes only if a detach interrupted playback.
   */
  attach(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    if (!this.primed) {
      this.primed = true;
      this.resetFuture(this.futureIndex);
      if (reducedMotion) this.finish();
      else this.play();
      return;
    }
    if (this.resumeOnAttach) {
      this.resumeOnAttach = false;
      this.play();
      return;
    }
    this.emitAll();
  }

  /** Off screen: stop the loop, and remember whether to pick up where it left off. */
  detach(): void {
    this.resumeOnAttach = this.playing;
    this.pause();
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  play = (): void => {
    if (this.failed) return;
    if (!this.primed) {
      this.primed = true;
      this.resetFuture(this.futureIndex);
    } else if (this.future.done) {
      this.resetFuture(this.futureIndex);
    }
    this.playing = true;
    this.lastTs = 0;
    this.schedule();
    this.emitAll();
  };

  pause = (): void => {
    const was = this.playing;
    this.playing = false;
    this.cancel();
    if (was) this.emitAll();
  };

  toggle = (): void => {
    if (this.playing) this.pause();
    else this.play();
  };

  restart = (): void => {
    this.resetFuture(this.futureIndex);
    this.play();
  };

  selectFuture = (index: number): void => {
    const k = ((Math.round(index) % this.futureCount) + this.futureCount) % this.futureCount;
    this.futureIndex = k;
    this.primed = true;
    this.resetFuture(k);
    if (this.reducedMotion) this.finish();
    else this.play();
  };

  nextFuture = (): void => this.selectFuture(this.futureIndex + 1);

  prevFuture = (): void => this.selectFuture(this.futureIndex - 1);

  setMode = (mode: SimMode): void => {
    if (mode === this.mode) return;
    this.mode = mode;
    this.emitAll();
  };

  /** Jump to `elapsed` weeks simulated (1..weeks). Keeps playing if it was. */
  seek = (elapsed: number): void => {
    if (this.failed) return;
    const target = Math.min(this.weeks, Math.max(1, Math.round(elapsed)));
    if (!this.primed) this.primed = true;
    if (target === this.future.week) return;
    if (target < this.future.week) {
      this.future = new Future(this.replay, this.seedFor(this.futureIndex));
      this.frame = null;
    }
    this.guard(() => {
      while (this.future.week < target && !this.future.done) this.stepOnce();
    });
    this.acc = 0;
    if (this.playing && this.future.done) {
      this.playing = false;
      this.cancel();
    }
    this.emitAll();
  };

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private seedFor(index: number): number {
    const seed = this.replay.seeds[index];
    return typeof seed === "number" && Number.isFinite(seed) ? seed : index + 1;
  }

  private resetFuture(index: number): void {
    this.cancel();
    this.generation++;
    this.future = new Future(this.replay, this.seedFor(index));
    this.frame = null;
    this.known = 0;
    this.acc = 0;
    this.servedHist.fill(0);
    this.downHist.fill(0);
    this.mapWeek = -1;
    // Week one is on screen immediately, so there is never a frame-less state.
    this.guard(() => {
      if (!this.future.done) this.stepOnce();
    });
  }

  private stepOnce(): void {
    const frame = this.future.step();
    this.frame = frame;
    if (frame.week < this.weeks) {
      this.servedHist[frame.week] = frame.result.served;
      this.downHist[frame.week] = frame.systemUp ? 0 : 1;
    }
    if (frame.week + 1 > this.known) this.known = Math.min(this.weeks, frame.week + 1);
  }

  /** Straight to the last week, for reduced motion. */
  private finish(): void {
    this.playing = false;
    this.cancel();
    this.guard(() => {
      while (!this.future.done) this.stepOnce();
    });
    this.emitAll();
  }

  /** A malformed replay stops the player once instead of throwing on every frame. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.failed = true;
      this.playing = false;
      this.cancel();
      console.error("[SimPlayer] simulation step failed:", error);
    }
  }

  private schedule(): void {
    if (this.raf || typeof window === "undefined") return;
    this.raf = window.requestAnimationFrame(this.tick);
  }

  private cancel(): void {
    if (this.raf && typeof window !== "undefined") window.cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (now: number): void => {
    this.raf = 0;
    if (!this.playing) return;

    if (this.lastTs === 0) this.lastTs = now;
    const dt = Math.min(MAX_FRAME_S, Math.max(0, (now - this.lastTs) / 1000));
    this.lastTs = now;
    this.acc += dt * this.weeksPerSecond;

    let steps = Math.floor(this.acc);
    this.acc -= steps;
    if (steps > 0) {
      this.guard(() => {
        while (steps-- > 0 && !this.future.done) this.stepOnce();
      });
    }

    if (this.failed || this.future.done) {
      this.playing = false;
      this.emitAll();
      return;
    }

    const week = this.frame ? this.frame.week : -1;
    if (week !== this.mapWeek && now - this.lastMapEmit >= MAP_INTERVAL_MS) {
      this.lastMapEmit = now;
      this.emitMap();
    }
    if (now - this.lastUiEmit >= UI_INTERVAL_MS) {
      this.lastUiEmit = now;
      this.emitUi();
    }
    this.schedule();
  };

  private view(): SimFrameView | null {
    const frame = this.frame;
    if (!frame) return null;
    const world = this.future.world;
    const result = frame.result;
    return {
      futureKey: `${this.replay.projectId}:${this.futureIndex}:${this.generation}`,
      week: frame.week,
      n: world.n,
      lon: world.lon,
      lat: world.lat,
      people: world.people,
      minutes: result.minutes,
      baseline: result.baseline,
      servedFrac: result.servedFrac,
      systemUp: frame.systemUp,
      mode: this.mode,
    };
  }

  private emitMap(): void {
    const view = this.view();
    if (!view) return;
    this.mapWeek = view.week;
    for (const listener of this.frameListeners) listener(view);
  }

  private emitUi(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.uiListeners) listener();
  }

  private emitAll(): void {
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    this.lastMapEmit = now;
    this.lastUiEmit = now;
    this.emitMap();
    this.emitUi();
  }

  private buildSnapshot(): PlaybackSnapshot {
    if (this.traceKnown !== this.known || this.traceGeneration !== this.generation) {
      this.trace = {
        served: Array.from(this.servedHist.subarray(0, this.known)),
        down: Array.from(this.downHist.subarray(0, this.known)),
      };
      this.traceKnown = this.known;
      this.traceGeneration = this.generation;
    }

    const frame = this.frame;
    const week = frame ? frame.week : 0;
    const served = frame ? frame.result.served : 0;
    const held = this.replay.passed[this.futureIndex];

    return {
      primed: this.primed,
      playing: this.playing,
      done: this.future.done,
      mode: this.mode,
      futureIndex: this.futureIndex,
      futureCount: this.futureCount,
      held: typeof held === "boolean" ? held : null,
      weeks: this.weeks,
      elapsed: Math.min(this.weeks, this.future.week),
      year: Math.floor(week / WEEKS_PER_YEAR) + 1,
      weekOfYear: (week % WEEKS_PER_YEAR) + 1,
      served,
      under30Share: frame && served > 0.5 ? Math.min(1, frame.result.under30 / served) : null,
      hoursSaved: frame ? frame.result.hoursSaved : 0,
      systemUp: frame ? frame.systemUp : true,
      capacityL: frame ? frame.capacityL : 0,
      clusters: this.future.world.n,
      designedServed: this.replay.designedServed,
      trace: this.trace,
    };
  }
}
