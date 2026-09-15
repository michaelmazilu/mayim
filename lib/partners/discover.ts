/**
 * Partner discovery — the fifth Exa query.
 *
 * Searches for water organisations working in the town's country and merges
 * them with the curated, URL-checked list in ./verified.ts. Search hits are
 * labelled `source: "search"` and never presented as vetted; the verified list
 * is always present, so the Partners tab is useful with no key at all.
 */

import type { Partner, PartnerFocus, PartnerKind } from "@/lib/types";
import {
  EXCLUDED_DOMAINS,
  exaApiKey,
  exaSearch,
  parseHits,
  type ExaHit,
  type ExaRequestBody,
} from "@/lib/evidence/exa";
import { hostnameOf } from "@/lib/evidence/structure";
import { countryIso2 } from "@/lib/geo/countries";
import { verifiedPartnersFor } from "@/lib/partners/verified";

const RESULTS = 8;
const MAX_PARTNERS = 14;

/** Hosts that publish ABOUT water organisations rather than being one. */
const NOT_AN_ORGANISATION = [
  ...EXCLUDED_DOMAINS,
  "wikipedia.org",
  "sciencedirect.com",
  "springer.com",
  "researchgate.net",
  "mdpi.com",
  "reliefweb.int",
  "devex.com",
  "globalgiving.org",
  "guidestar.org",
  "charitynavigator.org",
  "idealist.org",
  "medium.com",
  "bbc.com",
  "bbc.co.uk",
  "nation.africa",
  "standardmedia.co.ke",
  "monitor.co.ug",
  "newvision.co.ug",
  "graphic.com.gh",
  "myjoyonline.com",
  "allafrica.com",
];

const FOCUS_RULES: [PartnerFocus, RegExp][] = [
  ["boreholes", /\bbore ?holes?\b|\bdrill/i],
  ["handpumps", /\bhand ?pumps?\b/i],
  ["solar_pumping", /\bsolar\b/i],
  ["piped_schemes", /\bpiped\b|\bpipeline|\bkiosks?\b|\btap ?stands?\b|\butility\b/i],
  ["rainwater", /\brain ?water\b|\brainwater harvesting\b/i],
  ["water_quality", /\bwater quality\b|\bchlorin|\btreatment\b|\bfiltration\b|\bsafe water\b/i],
  ["maintenance", /\bmaintenance\b|\brepair|\bfunctionality\b|\bsustainab/i],
  ["sanitation", /\bsanitation\b|\btoilets?\b|\blatrines?\b|\bhygiene\b|\bwash\b/i],
  ["funding", /\bgrants?\b|\bfund(ing|s)?\b|\bdonat|\bfinanc/i],
  ["policy", /\bpolicy\b|\badvocacy\b|\bregulat|\bgovernance\b/i],
  ["emergency", /\bemergenc|\bhumanitarian\b|\brefugee|\bdisaster\b/i],
];

function hostIn(host: string, list: readonly string[]): boolean {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Registrable-ish root: "kenya.wateraid.org" → "wateraid.org", "kiwasco.co.ke" stays. */
export function rootDomain(host: string): string {
  const parts = host.split(".");
  const secondLevel = parts.length >= 3 && /^(co|or|go|ac|com|org|gov|ne)$/.test(parts[parts.length - 2]);
  return parts.slice(secondLevel ? -3 : -2).join(".");
}

/**
 * Organisation name from a page title. Titles look like
 * "Uganda | WaterAid", "Home - Water For People" or "KEWASNET: Kenya Water…",
 * so pick the segment that shares the most letters with the hostname.
 */
export function organisationName(title: string, host: string): string {
  const segments = title
    .split(/\s+[|–—:•·-]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && !/^(home|homepage|welcome|about us|official site)$/i.test(s));
  const label = rootDomain(host).split(".")[0].toLowerCase();
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best = segments[0] ?? label;
  let bestScore = -1;
  for (const seg of segments) {
    const sq = squash(seg);
    const score = sq.includes(label) || label.includes(sq) ? 100 - seg.length / 10 : 0;
    if (score > bestScore) {
      best = seg;
      bestScore = score;
    }
  }
  return best.slice(0, 80);
}

function kindFor(host: string, name: string): PartnerKind {
  if (/(^|\.)(gov|go\.[a-z]{2}|gov\.[a-z]{2}|gouv\.[a-z]{2})$/.test(host)) return "government";
  if (/\bnetwork\b|\bcoalition\b|\bassociation\b/i.test(name)) return "network";
  if (/\bfund\b|\bfoundation\b|\btrust\b/i.test(name)) return "funder";
  return "ngo";
}

function firstSentence(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentence = /^.{30,}?[.!?](\s|$)/.exec(clean)?.[0]?.trim() ?? clean;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

export function partnersFromHits(hits: ExaHit[], country: string): Partner[] {
  const seen = new Set<string>();
  const out: Partner[] = [];
  for (const hit of hits) {
    const host = hostnameOf(hit.url);
    if (!host || hostIn(host, NOT_AN_ORGANISATION)) continue;
    const root = rootDomain(host);
    if (seen.has(root)) continue;
    seen.add(root);

    const body = `${hit.title} ${hit.highlights.join(" ")} ${hit.text ?? ""}`;
    const name = organisationName(hit.title, host);
    out.push({
      id: `search-${root}`,
      name,
      kind: kindFor(host, name),
      country,
      url: hit.url,
      description: firstSentence(hit.highlights[0] ?? hit.text ?? hit.title),
      focus: FOCUS_RULES.filter(([, re]) => re.test(body)).map(([tag]) => tag),
      source: "search",
    });
  }
  return out;
}

/**
 * Country-verified first, then search finds not already on the list, then
 * global verified organisations. Deduplicated by root domain.
 */
export function mergePartners(verified: Partner[], found: Partner[], max = MAX_PARTNERS): Partner[] {
  const byRoot = (p: Partner) => rootDomain(hostnameOf(p.url));
  const local = verified.filter((p) => p.country !== "global");
  const global = verified.filter((p) => p.country === "global");
  const seen = new Set<string>();
  const out: Partner[] = [];
  for (const p of [...local, ...found, ...global]) {
    // Several verified entries can share a domain (e.g. a ministry and its agency);
    // only search hits are collapsed against what is already listed.
    const key = byRoot(p);
    if (p.source === "search" && seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

export type PartnerSearch = {
  partners: Partner[];
  status: "no_key" | "failed" | "empty" | "ok";
  found: number;
  error?: string;
};

function partnerQuery(countryName: string, category?: ExaRequestBody["category"], userLocation?: string): ExaRequestBody {
  return {
    query: `Non-profit organisation that drills boreholes and builds community water supply in ${countryName}`,
    numResults: RESULTS,
    type: "auto",
    ...(category ? { category } : {}),
    ...(userLocation ? { userLocation } : {}),
    excludeDomains: NOT_AN_ORGANISATION,
    contents: {
      highlights: { query: "what the organisation does for water supply in this country", maxCharacters: 400 },
      text: { maxCharacters: 600 },
    },
  };
}

/** Verified list plus live search finds for a country. Never throws. */
export async function discoverPartners(countryName: string | undefined): Promise<PartnerSearch> {
  const iso2 = countryIso2(countryName);
  const verified = verifiedPartnersFor(iso2);
  const apiKey = exaApiKey();
  if (!apiKey || !countryName) return { partners: verified, status: "no_key", found: 0 };

  // Org homepages index best under Exa's "company" category; widen if that is thin.
  let res = await exaSearch(partnerQuery(countryName, "company", iso2), apiKey);
  let hits = res.error === undefined ? parseHits(res.payload) : [];
  if (res.error === undefined && hits.length < 2) {
    res = await exaSearch(partnerQuery(countryName, undefined, iso2), apiKey);
    if (res.error === undefined) hits = [...hits, ...parseHits(res.payload)];
  }

  const found = partnersFromHits(hits, iso2 ?? "global");
  const status: PartnerSearch["status"] = res.error !== undefined && hits.length === 0 ? "failed" : found.length ? "ok" : "empty";
  return {
    partners: mergePartners(verified, found),
    status,
    found: found.length,
    ...(res.error !== undefined ? { error: res.error } : {}),
  };
}
