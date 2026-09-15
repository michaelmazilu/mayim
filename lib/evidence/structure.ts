/**
 * Deterministic structuring of raw Exa hits — the no-LLM path.
 *
 * With only an Exa key configured, live sources are still real sources and
 * should be shown. This module turns each hit into an EvidenceFinding using
 * nothing but the hit itself:
 *   - the summary is a verbatim excerpt, in quotation marks, never a paraphrase;
 *   - the publisher comes from a fixed hostname table, else the hostname;
 *   - confidence comes from publisher type, not from content;
 *   - there is NO scoreImpact. Reading direction ("increase"/"decrease") out of
 *     prose needs judgement, and a keyword rule would invent it. These findings
 *     raise evidence coverage but leave the factor signals at baseline.
 */

import type { EvidenceFinding } from "@/lib/types";
import { AUTHORITATIVE_DOMAINS, type RawEvidence } from "@/lib/evidence/exa";

/** Hostname suffix → publishing organisation. Longest suffix wins. */
const PUBLISHERS: [string, string][] = [
  ["washdata.org", "WHO/UNICEF Joint Monitoring Programme"],
  ["who.int", "World Health Organization"],
  ["unicef.org", "UNICEF"],
  ["worldbank.org", "World Bank"],
  ["fao.org", "Food and Agriculture Organization of the United Nations"],
  ["bgs.ac.uk", "British Geological Survey"],
  ["usgs.gov", "U.S. Geological Survey"],
  ["undp.org", "United Nations Development Programme"],
  ["unep.org", "UN Environment Programme"],
  ["unhabitat.org", "UN-Habitat"],
  ["un.org", "United Nations"],
  ["reliefweb.int", "ReliefWeb (UN OCHA)"],
  ["unhcr.org", "UNHCR"],
  ["wateraid.org", "WaterAid"],
  ["ircwash.org", "IRC WASH"],
  ["rural-water-supply.net", "Rural Water Supply Network"],
  ["afdb.org", "African Development Bank"],
  ["link.springer.com", "Springer"],
  ["sciencedirect.com", "Elsevier (ScienceDirect)"],
  ["mdpi.com", "MDPI"],
  ["iwaponline.com", "IWA Publishing"],
  ["frontiersin.org", "Frontiers"],
  ["nature.com", "Nature Portfolio"],
  ["wiley.com", "Wiley"],
  ["tandfonline.com", "Taylor & Francis"],
  ["researchgate.net", "ResearchGate"],
  ["wikipedia.org", "Wikipedia"],
  ["knbs.or.ke", "Kenya National Bureau of Statistics"],
  ["ubos.org", "Uganda Bureau of Statistics"],
  ["statsghana.gov.gh", "Ghana Statistical Service"],
  ["mwe.go.ug", "Uganda Ministry of Water and Environment"],
  // Resolvers and scholarly hosts — the hostname is not the publisher.
  ["doi.org", "Journal article (via DOI)"],
  ["hdl.handle.net", "Institutional repository (via Handle)"],
  ["ncbi.nlm.nih.gov", "PubMed Central (NIH)"],
  ["ascelibrary.org", "ASCE Library"],
  ["gca.org", "Global Center on Adaptation"],
  // Demo-town authorities, universities and national press.
  ["lvswwda.go.ke", "Lake Victoria South Water Works Development Agency"],
  ["kisumu.go.ke", "County Government of Kisumu"],
  ["city.kisumu.go.ke", "City of Kisumu"],
  ["nema.go.ke", "National Environment Management Authority (Kenya)"],
  ["uonbi.ac.ke", "University of Nairobi"],
  ["gulucity.go.ug", "Gulu City Council"],
  ["gu.ac.ug", "Gulu University"],
  ["monitor.co.ug", "Daily Monitor (Uganda)"],
  ["independent.co.ug", "The Independent (Uganda)"],
  ["gna.org.gh", "Ghana News Agency"],
  ["graphic.com.gh", "Graphic Online (Ghana)"],
  ["citinewsroom.com", "Citi Newsroom (Ghana)"],
];

/** Peer-reviewed publishers and repositories, scored like official/academic sources. */
const SCHOLARLY = [
  "doi.org",
  "hdl.handle.net",
  "ncbi.nlm.nih.gov",
  "sciencedirect.com",
  "mdpi.com",
  "iwaponline.com",
  "frontiersin.org",
  "nature.com",
  "wiley.com",
  "tandfonline.com",
  "ascelibrary.org",
];

const CATEGORY_NOUN: Record<RawEvidence["category"], string> = {
  water_need: "water access",
  hydrogeology: "hydrogeology",
  environment: "environmental risk",
  infrastructure: "water infrastructure",
};

const GENERIC_TITLE = /^(world bank document|open knowledge repository|documents?|pdf|untitled|home|download|file|attachment)$/i;

/**
 * Page titles from document repositories are often useless ("World Bank
 * Document", a bare URL, "GHA_GLAAS_final"). Tidy what can be tidied and
 * otherwise say plainly what the source is, rather than inventing a title.
 */
export function cleanTitle(title: string, url: string, publisher: string, category: RawEvidence["category"]): string {
  let t = title.trim();
  if (/^https?:\/\//i.test(t) || t === url) t = "";
  if ((t.match(/_/g)?.length ?? 0) >= 2) t = t.replace(/_+/g, " ").trim();
  t = t.replace(/\s+-\s+MediaWiki\b/i, "").trim();
  if (!t || GENERIC_TITLE.test(t)) return `${publisher} — ${CATEGORY_NOUN[category]} document`;
  return t;
}

const GOVERNMENT_HOST = /(^|\.)(gov|go\.[a-z]{2}|gov\.[a-z]{2}|gouv\.[a-z]{2}|mil)$/;
const ACADEMIC_HOST = /(^|\.)(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/;

const CONFIDENCE = {
  authoritative: 0.6,
  officialOrAcademic: 0.5,
  other: 0.35,
  /** Added when the excerpt or title names the town itself. */
  placeMentioned: 0.05,
  /** Verbatim excerpts with no reading are capped below LLM-structured ones. */
  ceiling: 0.65,
};

const SUMMARY_MAX = 240;

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Publishing organisation for a URL; the bare hostname when unknown. */
export function publisherFor(url: string): string {
  const host = hostnameOf(url);
  let best: [string, string] | null = null;
  for (const entry of PUBLISHERS) {
    if (hostMatches(host, entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : host || "Unknown publisher";
}

export function sourceTier(url: string): "authoritative" | "officialOrAcademic" | "other" {
  const host = hostnameOf(url);
  if (AUTHORITATIVE_DOMAINS.some((d) => hostMatches(host, d))) return "authoritative";
  if (GOVERNMENT_HOST.test(host) || ACADEMIC_HOST.test(host)) return "officialOrAcademic";
  if (SCHOLARLY.some((d) => hostMatches(host, d))) return "officialOrAcademic";
  return "other";
}

/** Whole sentences from the start of the text, up to `max` characters. */
export function leadingSentences(text: string, max = SUMMARY_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = "";
  for (const s of sentences) {
    if ((out + s).trim().length > max) break;
    out += s;
  }
  if (out.trim().length >= 40) return out.trim();
  // No sentence boundary in range: cut on a word boundary.
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}…`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function structureDeterministically(raw: RawEvidence[], placeName: string): EvidenceFinding[] {
  const needle = placeName.trim().toLowerCase();
  return raw.map((r, i) => {
    const excerpt = leadingSentences(r.highlights[0] ?? r.text ?? "", SUMMARY_MAX - 2);
    const haystack = `${r.title} ${r.highlights.join(" ")} ${r.text ?? ""}`.toLowerCase();
    const mentioned = needle.length > 0 && haystack.includes(needle);
    const confidence = Math.min(
      CONFIDENCE.ceiling,
      CONFIDENCE[sourceTier(r.url)] + (mentioned ? CONFIDENCE.placeMentioned : 0),
    );
    const publisher = publisherFor(r.url);
    const finding: EvidenceFinding = {
      id: `f${i.toString().padStart(2, "0")}`,
      category: r.category,
      title: cleanTitle(r.title, r.url, publisher, r.category).slice(0, 200),
      summary: `“${excerpt}”`,
      sourceName: publisher.slice(0, 120),
      sourceUrl: r.url,
      confidence: round2(confidence),
    };
    if (r.publishedDate) finding.publishedDate = r.publishedDate;
    return finding;
  });
}
