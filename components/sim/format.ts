/** Display helpers shared by the playback bar and the simulation tab. */

const MINUS = "−";

export function int(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const r = Math.round(n);
  const s = Math.abs(r).toLocaleString("en-US");
  return r < 0 ? `${MINUS}${s}` : s;
}

export function pct(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "—";
  return `${Math.round(share * 100)}%`;
}

export function usd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${int(n)}`;
}

/** "1,200 L/day", rounded to the nearest ten litres. */
export function litresPerDay(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${int(Math.round(n / 10) * 10)} L/day`;
}
