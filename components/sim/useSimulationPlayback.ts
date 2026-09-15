"use client";

/**
 * React bindings for the simulation player.
 *
 * `useSimulationPlayback` owns the player's lifetime: one per replay, attached
 * while the simulation stage is on screen. It deliberately returns the player
 * and not its state, so the component holding it (the page, and through it the
 * map) never re-renders because a week went by. Components that do show state
 * read it with `usePlaybackSnapshot`, which React sees at most ten times a
 * second; the map listens to `player.subscribeFrames` and never renders at all.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SimulationReplay } from "@/lib/types";
import { SimPlayer } from "./player";
import type { PlaybackSnapshot } from "./types";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia(REDUCED_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const readReducedMotion = (): boolean => window.matchMedia(REDUCED_QUERY).matches;
const serverReducedMotion = (): boolean => false;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, serverReducedMotion);
}

/**
 * One player per replay. While `active` it is attached: the first attach
 * auto-plays once (or, under reduced motion, shows the final week); leaving
 * the stage pauses it and coming back resumes it.
 */
export function useSimulationPlayback(
  replay: SimulationReplay | null,
  options: { active: boolean },
): SimPlayer | null {
  const { active } = options;
  const player = useMemo(() => (replay ? new SimPlayer(replay) : null), [replay]);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!player || !active) return;
    player.attach(reducedMotion);
    return () => player.detach();
  }, [player, active, reducedMotion]);

  return player;
}

const subscribeNothing = (): (() => void) => () => {};
const noSnapshot = (): null => null;

/** The transport bar's view of the player, throttled to at most 10 Hz by the player itself. */
export function usePlaybackSnapshot(player: SimPlayer | null): PlaybackSnapshot | null {
  return useSyncExternalStore<PlaybackSnapshot | null>(
    player ? player.subscribe : subscribeNothing,
    player ? player.getSnapshot : noSnapshot,
    noSnapshot,
  );
}
