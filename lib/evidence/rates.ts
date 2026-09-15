/**
 * Town-specific household-simulation rates, read from the retrieved evidence.
 *
 * The model's only job is to find a figure the excerpts state for this place
 * and quote the sentence it came from. Everything after that is code: each
 * quote is checked against the excerpt it claims to come from, values without
 * a verified citation are dropped, and what remains is clamped to planning
 * bounds and turned into weekly rates by the same formula as the defaults.
 * When nothing survives, the labelled planning defaults are used and the notes
 * say so.
 */
import { z } from "zod";
import type { SimulationRates, TownRef } from "@/lib/types";
import type { RawEvidence } from "@/lib/evidence/exa";
import { callOpenAI, isLlmConfigured } from "@/lib/evidence/llm";
import { defaultRates, ratesFromShares } from "@/lib/popsim/engine";

const FIELDS = ["nonFunctionalShare", "annualGrowthRate", "repairWeeks"] as const;
type RateField = (typeof FIELDS)[number];

export type ExtractedRates = {
  /** Share (0..1) of water points, handpumps or boreholes reported not working. */
  nonFunctionalShare: number | null;
  /** Population growth per year (0..1) for the town, district, region or country. */
  annualGrowthRate: number | null;
  /** Typical weeks from breakdown to repair. */
  repairWeeks: number | null;
  sources: { field: RateField; index: number; quote: string }[];
};

/** The range a desk study accepts from a document without a human looking. */
const BOUNDS: Record<RateField, { low: number; high: number }> = {
  nonFunctionalShare: { low: 0.05, high: 0.6 },
  annualGrowthRate: { low: 0, high: 0.08 },
  repairWeeks: { low: 1, high: 26 },
};

const MAX_QUOTE_CHARS = 200;
/** Same excerpt length as structureFindings, so both calls see the same text. */
const MAX_EXCERPT_CHARS = 1400;
const TIMEOUT_MS = 20_000;

const DEFAULTS_NOTE =
  "No town-specific breakdown, repair or growth figures were found in the retrieved sources, so the labelled planning defaults are used.";

// ---------------------------------------------------------------------------
// Extraction: one OpenAI call, then verification in code
// ---------------------------------------------------------------------------

const ExtractionSchema = z.object({
  nonFunctionalShare: z.number().nullable(),
  annualGrowthRate: z.number().nullable(),
  repairWeeks: z.number().nullable(),
  sources: z.array(z.object({ field: z.enum(FIELDS), index: z.number().int(), quote: z.string() })),
});

/** Mirrors ExtractionSchema for OpenAI structured outputs (strict mode). */
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["nonFunctionalShare", "annualGrowthRate", "repairWeeks", "sources"],
  properties: {
    nonFunctionalShare: { type: ["number", "null"], description: "Fraction 0..1 (32% -> 0.32), or null." },
    annualGrowthRate: { type: ["number", "null"], description: "Fraction per year (4.1% -> 0.041), or null." },
    repairWeeks: { type: ["number", "null"], description: "Weeks from breakdown to repair, or null." },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "index", "quote"],
        properties: {
          field: { type: "string", enum: FIELDS },
          index: { type: "integer" },
          quote: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM = [
  "You read retrieved excerpts about water supply in one town and extract at most three figures for a household water simulation.",
  "nonFunctionalShare: the share of water points, handpumps or boreholes reported as not working, as a fraction 0..1 (32% -> 0.32).",
  "annualGrowthRate: population growth per year, as a fraction 0..1 (4.1% -> 0.041).",
  "repairWeeks: the typical time from a breakdown to its repair, in weeks.",
  "Use a value ONLY if an excerpt states it for this town, its district, its region or its country; otherwise return null.",
  "Never estimate, infer or use outside knowledge. The only arithmetic allowed is turning a stated percentage into a fraction, stated days or months into weeks (1 month = 4.35 weeks), and a stated range into its midpoint.",
  `For every non-null value add one source entry with the excerpt index and the exact sentence from that excerpt that states it, copied verbatim, at most ${MAX_QUOTE_CHARS} characters.`,
  "When every value is null, return an empty sources array.",
].join(" ");

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Exactly the text the model is shown for one document. */
function excerptOf(r: RawEvidence): string {
  return (r.highlights.join(" ") || r.text || "").slice(0, MAX_EXCERPT_CHARS);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Trims, drops wrapping double quotes, and caps the length. */
function cleanQuote(quote: string): string {
  const text = quote.trim().replace(/^["“”]+|["“”]+$/g, "").trim();
  return text.length <= MAX_QUOTE_CHARS ? text : `${text.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`;
}

/** Case, quote marks, dashes and whitespace differ between a source and a faithful copy of it. */
function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the quote appears in the excerpt, allowing "..." elisions between its parts. */
function quotedIn(quote: string, excerpt: string): boolean {
  const haystack = normalise(excerpt);
  const parts = normalise(quote)
    .split(/\.{3,}/)
    .map((part) => part.replace(/^[\s"'.,;:]+|[\s"'.,;:]+$/g, ""))
    .filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/** A 0..1 figure returned above 1 was given as a percentage (32 for 32%). */
function asFraction(value: number): number {
  return value > 1 && value <= 100 ? value / 100 : value;
}

/** Keeps only sources whose quote is in the cited excerpt, and only values such a source supports. */
function verified(data: z.infer<typeof ExtractionSchema>, excerpts: string[]): ExtractedRates {
  const sources = data.sources
    .filter((s) => s.index >= 0 && s.index < excerpts.length && quotedIn(s.quote, excerpts[s.index]))
    .map((s) => ({ field: s.field, index: s.index, quote: cleanQuote(s.quote) }));
  const supported = (field: RateField, value: number | null): number | null =>
    value !== null && Number.isFinite(value) && sources.some((s) => s.field === field) ? value : null;
  const share = supported("nonFunctionalShare", data.nonFunctionalShare);
  const growth = supported("annualGrowthRate", data.annualGrowthRate);
  const out: ExtractedRates = {
    nonFunctionalShare: share === null ? null : asFraction(share),
    annualGrowthRate: growth === null ? null : asFraction(growth),
    repairWeeks: supported("repairWeeks", data.repairWeeks),
    sources: [],
  };
  out.sources = sources.filter((s) => out[s.field] !== null);
  return out;
}

/**
 * Asks the model for the three figures, then keeps only what the excerpts
 * verifiably state. Null when no key is configured, there are no sources, or
 * anything fails. Never throws.
 */
export async function extractRates(town: TownRef, raw: RawEvidence[]): Promise<ExtractedRates | null> {
  try {
    if (!isLlmConfigured() || raw.length === 0) return null;
    const excerpts = raw.map(excerptOf);
    if (excerpts.every((e) => e.length === 0)) return null;

    const place = [town.name, town.region, town.country].filter(Boolean).join(", ") || town.displayName;
    const docs = raw.map((r, index) => ({
      index,
      title: r.title,
      publisher: hostOf(r.url),
      publishedDate: r.publishedDate ?? null,
      excerpt: excerpts[index],
    }));
    const content = await callOpenAI(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Town under analysis: ${place}.\n\nExcerpts:\n${JSON.stringify(docs)}` },
      ],
      TIMEOUT_MS,
      { type: "json_schema", json_schema: { name: "town_rates", strict: true, schema: RESPONSE_SCHEMA } },
    );
    if (!content) return null;
    const parsed = ExtractionSchema.safeParse(JSON.parse(content));
    return parsed.success ? verified(parsed.data, excerpts) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Derivation: pure
// ---------------------------------------------------------------------------

type Cited = { value: number; quote: string; title: string; url: string };

/** The value for one field, if a source entry for it points at a real document with a quote. */
function cited(extracted: ExtractedRates | null, raw: RawEvidence[], field: RateField): Cited | null {
  const value = extracted?.[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  for (const source of extracted?.sources ?? []) {
    if (source.field !== field || !Number.isInteger(source.index)) continue;
    const doc = raw[source.index];
    const quote = typeof source.quote === "string" ? cleanQuote(source.quote) : "";
    if (doc && quote) return { value, quote, title: doc.title, url: doc.url };
  }
  return null;
}

const percent = (v: number) => `${Number((v * 100).toFixed(1))}%`;
const weeks = (v: number) => `${Number(v.toFixed(1))} weeks`;
const citation = (c: Cited) => `from "${c.quote}" (${c.title}, ${c.url})`;

/** Empty when the reported value was used as is; otherwise says it was limited. */
function limitedClause(reported: number, used: number, range: string, show: (v: number) => string): string {
  return reported === used ? "" : `, the reported ${show(reported)} limited to the accepted ${range} range`;
}

/**
 * Pure. Starts from the BEHAVIOUR planning defaults and replaces each figure
 * the evidence states and cites, clamped to BOUNDS. The new system keeps the
 * defaults' ratio of out-of-service shares to existing points, and weekly
 * failure probabilities come from ratesFromShares, exactly as for the defaults.
 */
export function deriveRates(
  extracted: ExtractedRates | null,
  raw: RawEvidence[],
  base: { rates: SimulationRates; notes: string[] } = { rates: defaultRates(), notes: [] },
): { rates: SimulationRates; notes: string[] } {
  let shareExisting = base.rates.shareExisting;
  let repairLow = base.rates.repairLow;
  let repairHigh = base.rates.repairHigh;
  let growth = base.rates.growth;
  const notes: string[] = [];

  const share = cited(extracted, raw, "nonFunctionalShare");
  if (share) {
    const { low, high } = BOUNDS.nonFunctionalShare;
    shareExisting = clamp(share.value, low, high);
    const limited = limitedClause(share.value, shareExisting, `${percent(low)}-${percent(high)}`, percent);
    notes.push(`Existing water points are out of service ${percent(shareExisting)} of the time${limited}, ${citation(share)}.`);
  }

  const growthRate = cited(extracted, raw, "annualGrowthRate");
  if (growthRate) {
    const { low, high } = BOUNDS.annualGrowthRate;
    growth = clamp(growthRate.value, low, high);
    const limited = limitedClause(growthRate.value, growth, `${percent(low)}-${percent(high)}`, percent);
    notes.push(`The population grows ${percent(growth)} a year${limited}, ${citation(growthRate)}.`);
  }

  const repair = cited(extracted, raw, "repairWeeks");
  if (repair) {
    const { low, high } = BOUNDS.repairWeeks;
    const typical = clamp(repair.value, low, high);
    repairLow = Math.max(1, Math.round(0.5 * typical));
    repairHigh = Math.min(52, Math.round(1.5 * typical));
    const limited = limitedClause(repair.value, typical, `${low}-${high} week`, weeks);
    notes.push(`Repairs take ${repairLow} to ${repairHigh} weeks around a typical ${weeks(typical)}${limited}, ${citation(repair)}.`);
  }

  if (notes.length === 0) {
    return { rates: base.rates, notes: base.notes.length > 0 ? base.notes : [DEFAULTS_NOTE] };
  }
  // Existing points break as often as their out-of-service share and repair time imply.
  const existing = ratesFromShares(shareExisting, 0, repairLow, repairHigh, growth);
  return {
    rates: { ...base.rates, shareExisting, failExisting: existing.failExisting, repairLow, repairHigh, growth },
    notes: [...notes, ...base.notes],
  };
}
