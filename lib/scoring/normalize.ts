/**
 * Deterministic normalisation helpers for suitability scoring.
 *
 * Every function here is pure and total: it returns a finite value inside
 * [0,1] for ANY input, including NaN and +/-Infinity. A single malformed
 * feature (a missing elevation tile, a degenerate distance) can therefore
 * never poison a whole run with NaN.
 */

/**
 * Decay constant for `saturate`. Chosen so `saturate(s, s)` === 1 - e^-2
 * ~= 0.8647, i.e. the documented "saturation point scores ~0.86" behaviour.
 */
const SATURATION_K = 2;

export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v <= 0) return 0; // also normalises -0 to +0 so equality stays stable
  if (v >= 1) return 1;
  return v;
}

/** Higher raw value -> lower score. Returns 1 at raw<=best, 0 at raw>=worst. */
export function inverseNormalize(raw: number, best: number, worst: number): number {
  if (Number.isNaN(raw)) return 0;
  if (raw <= best) return 1;
  if (raw >= worst) return 0;
  // Reaching here implies best < raw < worst, so the denominator is > 0 and a
  // degenerate range (best >= worst) has already returned above.
  return clamp01((worst - raw) / (worst - best));
}

/** Higher raw value -> higher score. Returns 0 at raw<=worst, 1 at raw>=best. */
export function forwardNormalize(raw: number, worst: number, best: number): number {
  if (Number.isNaN(raw)) return 0;
  if (raw <= worst) return 0;
  if (raw >= best) return 1;
  return clamp01((raw - worst) / (best - worst));
}

/** Diminishing-returns curve for counts (buildings, facilities). saturation = value scoring ~0.86. */
export function saturate(raw: number, saturation: number): number {
  if (Number.isNaN(raw) || raw <= 0) return 0;
  if (raw === Number.POSITIVE_INFINITY) return 1;
  if (Number.isNaN(saturation)) return 0;
  if (saturation === Number.POSITIVE_INFINITY) return 0; // nothing ever saturates
  if (saturation <= 0) return 1; // saturates immediately
  return clamp01(1 - Math.exp((-SATURATION_K * raw) / saturation));
}
