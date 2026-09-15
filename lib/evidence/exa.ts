/**
 * Exa research layer.
 *
 * Four evidence searches — one per category — run in parallel with a
 * per-request timeout. A category that comes back thin at town level is
 * retried once at region/country level without the domain allow-list, because
 * small towns rarely have their own hydrogeology report but their country
 * almost always does.
 *
 * This module never throws and never invents results. It reports WHY it came
 * back empty (no key, rejected key, out of credits, timeout) so the UI can say
 * "unreachable" instead of "not configured".
 */

import type { TownRef } from "@/lib/types";
import { countryIso2 } from "@/lib/geo/countries";

export type RawEvidence = {
  category: "water_need" | "hydrogeology" | "infrastructure" | "environment";
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights: string[];
  text?: string;
  /** Which query produced this hit. */
  tier?: QueryTier;
};

export type QueryTier = "town" | "broad";

export type QuerySpec = {
  category: RawEvidence["category"];
  tier: QueryTier;
  query: string;
  /** Steers which sentences Exa returns as highlights. */
  highlightQuery: string;
  restrictToAuthoritative: boolean;
};

export type QueryOutcome = {
  category: RawEvidence["category"];
  tier: QueryTier;
  query: string;
  results: number;
  error?: string;
};

export type EvidenceSearch = {
  /**
   * no_key — EXA_API_KEY unset; failed — every request errored;
   * empty  — requests succeeded but nothing usable came back; ok — ≥1 hit.
   */
  status: "no_key" | "failed" | "empty" | "ok";
  items: RawEvidence[];
  outcomes: QueryOutcome[];
  /** First error seen, for the data-sources panel. Never contains the key. */
  error?: string;
};

const EXA_ENDPOINT = "https://api.exa.ai/search";
const REQUEST_TIMEOUT_MS = 15_000;
const RESULTS_PER_QUERY = 5;
const MAX_TOTAL_RESULTS = 16;
/** Fewer town-level hits than this triggers the broad retry. */
const THIN_THRESHOLD = 2;

/**
 * Authoritative WASH / hydrogeology publishers. Applied only to the town-level
 * queries where source authority matters most; the broad retries and the
 * environment/infrastructure queries stay unrestricted so national ministries
 * (.go.ke, .gov.gh) and universities can surface.
 */
export const AUTHORITATIVE_DOMAINS = [
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
  "rural-water-supply.net",
  "link.springer.com",
];

/** Never useful as evidence; excluded whenever no allow-list is set. */
export const EXCLUDED_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "youtube.com",
  "pinterest.com",
  "linkedin.com",
  "tripadvisor.com",
  "booking.com",
];

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

function dedupeParts(raw: (string | undefined)[]): string[] {
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
  return parts;
}

/** "Kisumu, Kisumu County, Kenya" — deduped so "Lagos, Lagos, Nigeria" collapses. */
export function placeString(town: TownRef): string {
  const parts = dedupeParts([town.name, town.region, town.country]);
  return parts.length > 0 ? parts.join(", ") : town.displayName;
}

/** Region + country, or just the country. Null when there is nothing broader than the town. */
export function broadPlaceString(town: TownRef): string | null {
  const parts = dedupeParts([town.region, town.country]).filter(
    (p) => p.toLowerCase() !== town.name.trim().toLowerCase(),
  );
  if (parts.length === 0) return null;
  // A region alone ("Northern Region") is ambiguous without its country.
  if (!town.country) return null;
  return parts.join(", ");
}

/**
 * Exa's neural search matches documents that look like the query, so each
 * query reads like the opening line of the report we want, not a keyword bag.
 */
const TEMPLATES: Record<
  RawEvidence["category"],
  { query: (place: string) => string; highlight: string; authoritative: boolean }
> = {
  water_need: {
    query: (p) => `Assessment of drinking water access and unserved households in ${p}`,
    highlight: "share of households without safe drinking water, distance or time to water source, unserved communities",
    authoritative: true,
  },
  hydrogeology: {
    query: (p) => `Hydrogeology and groundwater potential of ${p}: aquifers, borehole yields and depth to water`,
    highlight: "aquifer type, borehole yield, depth to groundwater, drilling success rate",
    authoritative: true,
  },
  environment: {
    query: (p) => `Flooding, drought and water quality contamination risks in ${p}`,
    highlight: "flood risk, drought, groundwater contamination, water quality",
    authoritative: false,
  },
  infrastructure: {
    query: (p) => `Water supply projects, boreholes and piped schemes built or planned in ${p}`,
    highlight: "boreholes, piped water scheme, handpumps, rehabilitation, water project funding",
    authoritative: false,
  },
};

const CATEGORY_ORDER: RawEvidence["category"][] = ["water_need", "hydrogeology", "environment", "infrastructure"];

export function buildQueries(town: TownRef, tier: QueryTier = "town"): QuerySpec[] {
  const place = tier === "town" ? placeString(town) : broadPlaceString(town);
  if (!place) return [];
  return CATEGORY_ORDER.map((category) => {
    const t = TEMPLATES[category];
    return {
      category,
      tier,
      query: t.query(place),
      highlightQuery: t.highlight,
      // Broad retries exist precisely because the allow-list came back thin.
      restrictToAuthoritative: tier === "town" && t.authoritative,
    };
  });
}

// ---------------------------------------------------------------------------
// Defensive JSON readers (the API response is untrusted `unknown`)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asText(value: unknown): string | undefined {
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

/** A validated search hit, before it is assigned an evidence category. */
export type ExaHit = Omit<RawEvidence, "category" | "tier">;

export function parseHits(payload: unknown): ExaHit[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.results)) return [];

  const out: ExaHit[] = [];
  for (const entry of root.results) {
    const record = asRecord(entry);
    if (!record) continue;
    const url = asText(record.url);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const highlights = asTextList(record.highlights);
    const text = asText(record.text);
    // A hit with neither highlights nor text carries nothing for the extractor.
    if (highlights.length === 0 && !text) continue;

    const item: ExaHit = { title: asText(record.title) ?? url, url, highlights };
    const publishedDate = asText(record.publishedDate);
    if (publishedDate) item.publishedDate = publishedDate.slice(0, 10);
    const author = asText(record.author);
    if (author) item.author = author;
    if (text) item.text = text.slice(0, 1200);
    out.push(item);
  }
  return out;
}

export function parseResults(payload: unknown, category: RawEvidence["category"]): RawEvidence[] {
  return parseHits(payload).map((hit) => ({ ...hit, category }));
}

export function urlKey(url: string): string {
  return url.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function exaApiKey(): string | null {
  const key = process.env.EXA_API_KEY?.trim();
  return key ? key : null;
}

export function isExaConfigured(): boolean {
  return exaApiKey() !== null;
}

export type ExaRequestBody = {
  query: string;
  numResults: number;
  type: "auto" | "fast";
  category?: "company" | "publication" | "news";
  userLocation?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  contents: {
    highlights: { query?: string; maxCharacters: number };
    text: { maxCharacters: number };
  };
};

/** One Exa call. Returns the raw payload, or a short error label. Never throws. */
export async function exaSearch(
  body: ExaRequestBody,
  apiKey: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ payload: unknown; error?: undefined } | { payload?: undefined; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(EXA_ENDPOINT, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      // Exa returns { error, tag } — the tag is a stable machine label (INVALID_API_KEY, NO_MORE_CREDITS…).
      let tag = "";
      try {
        const data = asRecord(await response.json());
        tag = asText(data?.tag) ?? "";
      } catch {
        /* non-JSON error body */
      }
      return { error: `HTTP ${response.status}${tag ? ` ${tag}` : ""}` };
    }
    return { payload: (await response.json()) as unknown };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { error: aborted ? `timeout after ${Math.round(timeoutMs / 1000)} s` : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

async function runQuery(
  spec: QuerySpec,
  apiKey: string,
  userLocation: string | undefined,
): Promise<{ items: RawEvidence[]; outcome: QueryOutcome }> {
  const body: ExaRequestBody = {
    query: spec.query,
    numResults: RESULTS_PER_QUERY,
    type: "auto",
    contents: {
      highlights: { query: spec.highlightQuery, maxCharacters: 600 },
      text: { maxCharacters: 1200 },
    },
  };
  if (userLocation) body.userLocation = userLocation;
  if (spec.restrictToAuthoritative) body.includeDomains = AUTHORITATIVE_DOMAINS;
  else body.excludeDomains = EXCLUDED_DOMAINS;

  const res = await exaSearch(body, apiKey);
  const base = { category: spec.category, tier: spec.tier, query: spec.query };
  if (res.error !== undefined) return { items: [], outcome: { ...base, results: 0, error: res.error } };
  const items = parseResults(res.payload, spec.category).map((item) => ({ ...item, tier: spec.tier }));
  return { items, outcome: { ...base, results: items.length } };
}

/**
 * Interleave categories round-robin so one prolific category cannot crowd the
 * others out of the total cap. Deterministic: category order, then Exa rank.
 */
export function mergeEvidence(perCategory: RawEvidence[][], cap = MAX_TOTAL_RESULTS): RawEvidence[] {
  const seen = new Set<string>();
  const merged: RawEvidence[] = [];
  const longest = Math.max(0, ...perCategory.map((list) => list.length));
  for (let rank = 0; rank < longest; rank++) {
    for (const list of perCategory) {
      const item = list[rank];
      if (!item) continue;
      const key = urlKey(item.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= cap) return merged;
    }
  }
  return merged;
}

/** Full search with per-query diagnostics. Never throws. */
export async function searchEvidenceDetailed(town: TownRef): Promise<EvidenceSearch> {
  const apiKey = exaApiKey();
  if (!apiKey) return { status: "no_key", items: [], outcomes: [] };

  const userLocation = countryIso2(town.country);
  const townSpecs = buildQueries(town, "town");
  const first = await Promise.all(townSpecs.map((spec) => runQuery(spec, apiKey, userLocation)));

  // A rejected key or exhausted credits will fail the retries too — skip them.
  const fatal = first.find((r) => /HTTP (401|402)/.test(r.outcome.error ?? ""));
  const broadSpecs = fatal ? [] : buildQueries(town, "broad");
  const thin = first
    .map((r, i) => ({ r, spec: broadSpecs[i] }))
    .filter(({ r, spec }) => spec && !r.outcome.error && r.items.length < THIN_THRESHOLD);
  const retries = await Promise.all(thin.map(({ spec }) => runQuery(spec, apiKey, userLocation)));

  const perCategory = first.map((r) => {
    const retry = retries.find((x) => x.outcome.category === r.outcome.category);
    return retry ? [...r.items, ...retry.items] : r.items;
  });
  const outcomes = [...first.map((r) => r.outcome), ...retries.map((r) => r.outcome)];
  const items = mergeEvidence(perCategory);
  const error = outcomes.find((o) => o.error)?.error;

  const status: EvidenceSearch["status"] =
    items.length > 0 ? "ok" : outcomes.every((o) => o.error) ? "failed" : "empty";
  return { status, items, outcomes, ...(error ? { error } : {}) };
}

/** Returns [] when EXA_API_KEY is absent or every request fails. Never throws. */
export async function searchEvidence(town: TownRef): Promise<RawEvidence[]> {
  return (await searchEvidenceDetailed(town)).items;
}
