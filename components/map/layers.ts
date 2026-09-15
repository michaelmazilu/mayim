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
  | "households"
  | "design";

export const LAYER_META: { id: LayerId; label: string }[] = [
  { id: "satellite", label: "Satellite" },
  { id: "suitability", label: "Suitability" },
  { id: "roads", label: "Roads" },
  { id: "water", label: "Waterways" },
  { id: "existing", label: "Existing service" },
  { id: "environment", label: "Constraints" },
  { id: "households", label: "Household journeys" },
  { id: "design", label: "Conceptual design" },
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
  | "households"
  | "top3"
  | "tour3"
  | "tour2"
  | "winner"
  | "design";

export const STAGE_ORDER: MapStage[] = [
  "idle",
  "town",
  "context",
  "facilities",
  "constraints",
  "candidates",
  "eliminated",
  "heatmap",
  "households",
  "top3",
  "tour3",
  "tour2",
  "winner",
  "design",
];

/** Stage index helper so components can ask "have we reached X yet". */
export function stageReached(current: MapStage, target: MapStage): boolean {
  const currentIndex = STAGE_ORDER.indexOf(current);
  const targetIndex = STAGE_ORDER.indexOf(target);
  if (currentIndex < 0 || targetIndex < 0) return false;
  return currentIndex >= targetIndex;
}
