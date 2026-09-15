/**
 * mulberry32: a small, fast, seedable 32-bit generator. Good enough for
 * sampling futures and, unlike Math.random(), reproducible from its seed.
 */
export type Rng = {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [low, high], both inclusive. */
  int(low: number, high: number): number;
  /** Uniform real in [low, high). */
  range(low: number, high: number): number;
};

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    range: (low, high) => low + next() * (high - low),
  };
}
