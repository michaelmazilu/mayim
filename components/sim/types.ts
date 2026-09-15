/**
 * Shapes shared by the household-simulation replay: what the player hands the
 * map on every frame, what it hands React at most ten times a second, and the
 * per-replay constants that both scale against.
 */
import type { SimulationReplay } from "@/lib/types";

/** "today": no project, every household on its current source. "project": with the new taps. */
export type SimMode = "today" | "project";

/**
 * One simulated week, as the map reads it.
 *
 * The arrays are the engine's own working buffers, indexed by cluster and only
 * meaningful up to `n`. They are overwritten by the next step, so a listener
 * must read them synchronously and never keep them.
 */
export type SimFrameView = {
  /** Changes when the future changes, so a listener can tell a new future from a new week. */
  futureKey: string;
  /** 0-based index of the week just simulated. */
  week: number;
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  people: Float64Array;
  /** Round trip with the project, minutes. */
  minutes: Float64Array;
  /** Round trip without the project, minutes. */
  baseline: Float64Array;
  /** Share of the cluster's demand met by the new taps, 0..1. */
  servedFrac: Float64Array;
  systemUp: boolean;
  mode: SimMode;
};

/** Constants of one replay, computed once, that keep the map's scales stable across weeks. */
export type ReplayStats = {
  /** [[west, south], [east, north]] of the week-zero clusters and the taps. */
  bounds: [[number, number], [number, number]];
  centerLat: number;
  /** Median people per cluster at week zero. */
  peopleRef: number;
  /** 90th percentile of people x round-trip minutes at week zero, without the project. */
  weightRef: number;
  /** Median distance from a cluster to its nearest neighbour, metres. */
  spacingM: number;
};

/** The map's view of a playback: static facts plus a frame stream. */
export interface SimulationFeed {
  readonly replay: SimulationReplay;
  readonly stats: ReplayStats;
  /** Called at most ~15 times a second while playing, and once per discrete change. */
  subscribeFrames(listener: (view: SimFrameView) => void): () => void;
  /** The current frame, for a listener that subscribes late; null before the first step. */
  peekFrame(): SimFrameView | null;
}

/** Per-week history of the current future, for the scrubber. Index = week. */
export type PlaybackTrace = {
  served: number[];
  /** 1 when the new system was out of service that week. */
  down: number[];
};

/** Everything the transport bar renders. Immutable: a new object per update. */
export type PlaybackSnapshot = {
  primed: boolean;
  playing: boolean;
  done: boolean;
  mode: SimMode;
  futureIndex: number;
  futureCount: number;
  /** Whether this future held (from the server's stress test); null when unknown. */
  held: boolean | null;
  weeks: number;
  /** Weeks simulated so far in this future, 0..weeks. */
  elapsed: number;
  /** 1-based. */
  year: number;
  /** 1-based. */
  weekOfYear: number;
  served: number;
  /** Share of the people served whose round trip, queue included, is 30 minutes or less. */
  under30Share: number | null;
  hoursSaved: number;
  systemUp: boolean;
  capacityL: number;
  clusters: number;
  designedServed: number;
  trace: PlaybackTrace;
};
