/**
 * Map layer catalogue and reveal-sequence stages.
 *
 * `MapStage` drives the cinematic reveal (one-way, monotonic), while `LayerId`
 * drives the user's manual toggles. Both are consumed by AquaMap; the stage
 * decides when a group *may* appear, the toggle decides whether it does.
 */

export type LayerId =
  | "satellite"
  | "suitability"
  | "roads"
  | "water"
  | "existing"
  | "environment"
  | "design"
  | "simulation";

export const LAYER_META: { id: LayerId; label: string }[] = [
  { id: "satellite", label: "Satellite" },
  { id: "suitability", label: "Suitability" },
  { id: "roads", label: "Roads" },
  { id: "water", label: "Waterways" },
  { id: "existing", label: "Existing service" },
  { id: "environment", label: "Constraints" },
  { id: "design", label: "Conceptual design" },
  { id: "simulation", label: "Household simulation" },
];

/**
 * `top3` frames all three finalists at once; `tour3` and `tour2` then visit the
 * runners-up in worst-to-best order so the winner arrives as the end of an
 * argument rather than as an assertion.
 */
export type MapStage =
  | "idle"
  | "town"
  | "context"
  | "facilities"
  | "constraints"
  | "candidates"
  | "eliminated"
  | "heatmap"
  | "top3"
  | "tour3"
  | "tour2"
  | "winner"
  | "design"
  | "simulation"
  | "closing";

export const STAGE_ORDER: MapStage[] = [
  "idle",
  "town",
  "context",
  "facilities",
  "constraints",
  "candidates",
  "eliminated",
  "heatmap",
  "top3",
  "tour3",
  "tour2",
  "winner",
  "design",
  /* Only reached when the run carries a replayable simulation. */
  "simulation",
  /* The closing shot: back down onto the installation the whole run argued
     for, after the ten years have played out across the town. */
  "closing",
];

/** Stage index helper so components can ask "have we reached X yet". */
export function stageReached(current: MapStage, target: MapStage): boolean {
  const currentIndex = STAGE_ORDER.indexOf(current);
  const targetIndex = STAGE_ORDER.indexOf(target);
  if (currentIndex < 0 || targetIndex < 0) return false;
  return currentIndex >= targetIndex;
}
