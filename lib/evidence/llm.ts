/**
 * LLM structuring layer (OpenAI).
 *
 * The model's ONLY jobs are to classify, summarise and attribute retrieved
 * sources. It never chooses coordinates and never produces a cost, yield or
 * population total — those come from the deterministic models in lib/.
 * Every numeric it does emit (confidence, scoreImpact.magnitude) is clamped in
 * code after parsing, so the model's ranges are never trusted.
 */
import { z } from "zod";
import type {
  EvidenceCategory,
  EvidenceFinding,
  InfrastructureRecommendation,
  ScoreFactor,
  TownRef,
} from "@/lib/types";
import type { RawEvidence } from "@/lib/evidence/exa";
import { canonicalPublisher, publisherFor } from "@/lib/evidence/structure";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_MAGNITUDE = 0.35;

export function llmModel(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/** Short label for the UI provenance chip. Never includes the key. */
export function llmLabel(): string {
  return `OpenAI ${llmModel()}`;
}

const CATEGORIES = [
  "water_need",
  "hydrogeology",
  "infrastructure",
  "environment",
  "regulation",
] as const satisfies readonly EvidenceCategory[];

const FACTORS = ["need", "groundwater", "risk", "cost", "access"] as const satisfies readonly ScoreFactor[];

const FindingSchema = z.object({
  category: z.enum(CATEGORIES),
  title: z.string().min(1),
  summary: z.string().min(1),
  sourceName: z.string().min(1),
  confidence: z.number(),
  impactFactor: z.union([z.enum(FACTORS), z.null()]),
  impactDirection: z.union([z.enum(["increase", "decrease", "unknown"]), z.null()]),
  impactMagnitude: z.union([z.number(), z.null()]),
});

const BatchSchema = z.object({ findings: z.array(FindingSchema) });

/** Mirrors BatchSchema for OpenAI structured outputs (strict mode). */
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "category",
          "title",
          "summary",
          "sourceName",
          "confidence",
          "impactFactor",
          "impactDirection",
          "impactMagnitude",
        ],
        properties: {
          category: { type: "string", enum: CATEGORIES },
          title: { type: "string" },
          summary: { type: "string" },
          sourceName: { type: "string" },
          confidence: { type: "number" },
          impactFactor: { type: ["string", "null"], enum: [...FACTORS, null] },
          impactDirection: { type: ["string", "null"], enum: ["increase", "decrease", "unknown", null] },
          impactMagnitude: { type: ["number", "null"] },
        },
      },
    },
  },
} as const;

const SYSTEM = [
  "You structure retrieved documents for a water-infrastructure pre-feasibility tool.",
  "Do not invent numbers. Do not choose locations or coordinates.",
  "Do not estimate costs, water yields, or population totals — other systems compute those.",
  "If the provided source text does not support a claim, omit the claim.",
  "Summaries must be grounded strictly in the supplied excerpt text: ONE short factual sentence, max 25 words, no marketing language.",
  "sourceName is the publishing organisation (e.g. 'World Health Organization'), not the article title.",
  "confidence is 0..1 and reflects how authoritative and on-topic the source is for this specific town.",
  "Set impactFactor/impactDirection/impactMagnitude only when the excerpt makes a claim about this town or its immediate region that bears on the factor; otherwise set all three to null.",
  "Factor meanings — 'increase' always means MORE of the named quantity:",
  "need = share of people lacking safe drinking water (increase = more unmet need).",
  "groundwater = likelihood a drilled borehole finds productive water (increase = productive aquifer, good yields; decrease = low or variable yields, high drilling failure, deep water table). Only for sources describing the aquifer itself.",
  "risk = environmental hazard to a water point: flooding, contamination, drought (increase = more hazard).",
  "cost = pressure on construction or operating cost, e.g. deep drilling, hard rock, remoteness (increase = more expensive). Funding announcements and project budgets are NOT cost evidence.",
  "access = difficulty of reaching a site for construction (increase = harder to reach; decrease = good roads and nearby supply chains).",
  "News about planned or funded water projects is infrastructure context: classify it, but leave its impact null.",
  `impactMagnitude must never exceed ${MAX_MAGNITUDE}.`,
].join(" ");

type ChatResponse = { choices?: { message?: { content?: string } }[] };

export async function callOpenAI(
  messages: { role: "system" | "user"; content: string }[],
  timeoutMs: number,
  responseFormat?: Record<string, unknown>,
): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llmModel(),
        temperature: 0,
        messages,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ChatResponse;
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

/**
 * Converts raw retrieved sources into validated findings.
 * Returns null on any failure so the caller can fall back deterministically.
 */
export async function structureFindings(
  town: TownRef,
  raw: RawEvidence[],
): Promise<EvidenceFinding[] | null> {
  if (!isLlmConfigured() || raw.length === 0) return null;

  const place = [town.name, town.region, town.country].filter(Boolean).join(", ");
  const docs = raw.map((r, i) => ({
    index: i,
    retrievedFor: r.category,
    title: r.title,
    publisherHint: publisherFor(r.url),
    publishedDate: r.publishedDate ?? null,
    excerpt: (r.highlights.join(" ") || r.text || "").slice(0, 1400),
  }));

  const content = await callOpenAI(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `Town under analysis: ${place}.\n\n` +
          `Return one finding per source, in the same order, preserving array length ${docs.length}.\n\n` +
          JSON.stringify(docs),
      },
    ],
    25_000,
    { type: "json_schema", json_schema: { name: "evidence_batch", strict: true, schema: RESPONSE_SCHEMA } },
  );
  if (!content) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = BatchSchema.safeParse(parsedJson);
  if (!parsed.success) return null;

  const findings: EvidenceFinding[] = [];
  parsed.data.findings.forEach((f, i) => {
    // The URL is never supplied by the model — it comes from the retrieval hit.
    const src = raw[i];
    if (!src) return;
    const magnitude = f.impactMagnitude === null ? 0 : clamp(f.impactMagnitude, 0, MAX_MAGNITUDE);
    const hasImpact = f.impactFactor !== null && f.impactDirection !== null && magnitude > 0;
    findings.push({
      id: `f${i.toString().padStart(2, "0")}`,
      category: f.category,
      title: f.title.slice(0, 200),
      summary: f.summary.slice(0, 240),
      sourceName: canonicalPublisher(src.url, f.sourceName).slice(0, 120),
      sourceUrl: src.url,
      publishedDate: src.publishedDate,
      confidence: clamp(f.confidence, 0, 1),
      ...(hasImpact && f.impactFactor && f.impactDirection
        ? { scoreImpact: { factor: f.impactFactor, direction: f.impactDirection, magnitude } }
        : {}),
    });
  });

  return findings.length > 0 ? findings : null;
}

/** Two-sentence plain-language summary. Returns null on failure. */
export async function writeNarrative(args: {
  town: TownRef;
  recommendation: InfrastructureRecommendation;
  topScore: number;
  findings: EvidenceFinding[];
  population: number;
}): Promise<string | null> {
  if (!isLlmConfigured()) return null;
  const { town, recommendation: r, topScore, findings, population } = args;

  const content = await callOpenAI(
    [
      {
        role: "system",
        content:
          "You write concise, sober summaries for infrastructure planners. " +
          "Use ONLY the figures supplied — never introduce a number that is not given to you, and never round differently. " +
          "No marketing language, no adjectives like 'revolutionary'. " +
          "Write EXACTLY two short sentences, 45 words total maximum. Be terse — no preamble, no restating the question. " +
          "End by noting these are pre-feasibility estimates needing field validation.",
      },
      {
        role: "user",
        content: JSON.stringify({
          town: town.displayName,
          intervention: r.label,
          suitabilityScorePercent: Math.round(topScore * 100),
          costRangeUsd: [r.cost.totalLow, r.cost.totalHigh],
          dailyOutputLitersRange: [r.output.dailyLitersLow, r.output.dailyLitersHigh],
          peopleWithinServiceRadius: population,
          peopleSystemCanSupply: [r.output.peopleSupportedLow, r.output.peopleSupportedHigh],
          confidencePercent: Math.round(r.confidence * 100),
          evidenceSourceCount: findings.length,
          keyRationale: r.rationale.slice(0, 4),
        }),
      },
    ],
    20_000,
  );
  const text = content?.trim();
  return text && text.length > 30 ? text : null;
}
