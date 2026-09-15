/**
 * Exa research layer.
 *
 * Exactly four searches — one per evidence category — run in parallel with a
 * per-request timeout. This module never throws and never invents results: if
 * the key is missing or every request fails, callers get an empty array and are
 * expected to fall back to bundled demo evidence.
 */

import type { TownRef } from "@/lib/types";

export type RawEvidence = {
  category: "water_need" | "hydrogeology" | "infrastructure" | "environment";
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights: string[];
  text?: string;
};

const EXA_ENDPOINT = "https://api.exa.ai/search";
const REQUEST_TIMEOUT_MS = 15_000;
const RESULTS_PER_QUERY = 5;
const MAX_TOTAL_RESULTS = 16;

/**
 * Authoritative WASH / hydrogeology publishers. Applied only to the two
 * queries where source authority matters most; the environment and
 * infrastructure queries stay unrestricted so national ministries (.gov) and
 * universities (.edu) can surface.
 */
const AUTHORITATIVE_DOMAINS = [
  "who.int",
  "unicef.org",
  "washdata.org",
  "worldbank.org",
  "fao.org",
  "bgs.ac.uk",
  "usgs.gov",
  "un.org",
  "undp.org",
  "reliefweb.int",
  "wateraid.org",
  "ircwash.org",
  "link.springer.com",
];

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/** "Kisumu, Kisumu County, Kenya" — deduped so "Lagos, Lagos, Nigeria" collapses. */
function placeString(town: TownRef): string {
  const raw = [town.name, town.region, town.country];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of raw) {
    if (typeof part !== "string") continue;
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(trimmed);
  }
  return parts.length > 0 ? parts.join(", ") : town.displayName;
}

export function buildQueries(town: TownRef): { category: RawEvidence["category"]; query: string }[] {
  const place = placeString(town);
  return [
    {
      category: "water_need",
      query: `Drinking water access, water shortage and unserved communities in ${place} — coverage gaps, distance to safe water, WASH needs assessment`,
    },
    {
      category: "hydrogeology",
      query: `Hydrogeology of ${place} — aquifer type and productivity, groundwater potential, borehole yield, depth to water table, drilling success rate`,
    },
    {
      category: "environment",
      query: `Water-related environmental risk in ${place} — flooding, drought, groundwater contamination, water quality and pollution`,
    },
    {
      category: "infrastructure",
      query: `Existing and planned water supply infrastructure in ${place} — boreholes, piped schemes, handpumps, water projects and rehabilitation programmes`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Defensive JSON readers (the API response is untrusted `unknown`)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = asText(entry);
    if (text) out.push(text);
  }
  return out;
}

function parseResults(payload: unknown, category: RawEvidence["category"]): RawEvidence[] {
  const root = asRecord(payload);
  if (!root) return [];
  const results = root.results;
  if (!Array.isArray(results)) return [];

  const out: RawEvidence[] = [];
  for (const entry of results) {
    const record = asRecord(entry);
    if (!record) continue;
    const url = asText(record.url);
    if (!url) continue;
    const highlights = asTextList(record.highlights);
    const text = asText(record.text);
    // A hit with neither highlights nor text carries nothing for the extractor.
    if (highlights.length === 0 && !text) continue;

    const item: RawEvidence = {
      category,
      title: asText(record.title) ?? url,
      url,
      highlights,
    };
    const publishedDate = asText(record.publishedDate);
    if (publishedDate) item.publishedDate = publishedDate;
    const author = asText(record.author);
    if (author) item.author = author;
    if (text) item.text = text.slice(0, 1200);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

type ExaRequestBody = {
  query: string;
  numResults: number;
  type: "auto";
  contents: {
    highlights: { numSentences: number; highlightsPerUrl: number };
    text: { maxCharacters: number };
  };
  includeDomains?: string[];
};

async function runQuery(
  spec: { category: RawEvidence["category"]; query: string },
  apiKey: string,
): Promise<RawEvidence[]> {
  const body: ExaRequestBody = {
    query: spec.query,
    numResults: RESULTS_PER_QUERY,
    type: "auto",
    contents: {
      highlights: { numSentences: 3, highlightsPerUrl: 2 },
      text: { maxCharacters: 1200 },
    },
  };
  if (spec.category === "water_need" || spec.category === "hydrogeology") {
    body.includeDomains = AUTHORITATIVE_DOMAINS;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(EXA_ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    return parseResults(payload, spec.category);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Returns [] when EXA_API_KEY is absent or every request fails. Never throws. */
export async function searchEvidence(town: TownRef): Promise<RawEvidence[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) return [];

  const specs = buildQueries(town);
  const settled = await Promise.allSettled(specs.map((spec) => runQuery(spec, apiKey.trim())));

  // Deterministic merge: category order first, then Exa's own ranking.
  const seenUrls = new Set<string>();
  const merged: RawEvidence[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    for (const item of outcome.value) {
      const key = item.url.trim().toLowerCase().replace(/\/+$/, "");
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      merged.push(item);
      if (merged.length >= MAX_TOTAL_RESULTS) return merged;
    }
  }
  return merged;
}
