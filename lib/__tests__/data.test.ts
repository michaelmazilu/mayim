/**
 * Unit tests for the data layer: Exa query/merge/parse, deterministic
 * structuring, partners, the project brief, cost per person, behaviour rates
 * and the WorldPop polygon. No network: every test runs without API keys.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  AnalysisRun,
  EvidenceFinding,
  InfrastructureRecommendation,
  Partner,
  ScoreFactor,
  TownRef,
} from "@/lib/types";
import { aggregateSignals, MAX_FACTOR_SHIFT, NEUTRAL_SIGNALS } from "@/lib/evidence/signals";
import { loadEvidenceSnapshot } from "@/lib/evidence/snapshot";
import { countryIso2, countryIso3 } from "@/lib/geo/countries";
import { classifyStatus, parseDistrictRows, type DistrictStatusRow } from "@/lib/providers/wpdx";
import { buildRegionalScan, rollupDistricts } from "@/lib/scan/regional";
import {
  buildQueries,
  mergeEvidence,
  parseHits,
  searchEvidenceDetailed,
  urlKey,
  type RawEvidence,
} from "@/lib/evidence/exa";
import {
  canonicalPublisher,
  cleanTitle,
  leadingSentences,
  publisherFor,
  sourceTier,
  structureDeterministically,
} from "@/lib/evidence/structure";
import {
  discoverPartners,
  mergePartners,
  organisationName,
  partnersFromHits,
  rootDomain,
} from "@/lib/partners/discover";
import { VERIFIED_PARTNERS, verifiedPartnersFor } from "@/lib/partners/verified";
import { costPerPersonServed } from "@/lib/metrics/cost-per-person";
import { buildProjectBrief } from "@/lib/brief/brief";
import {
  CITY_GROWTH,
  DEMAND_LITERS_PER_PERSON_DAY,
  DROUGHT_FUNCTIONALITY,
  HOUSEHOLD_SIZE,
  MOTORISED_SCHEME_DOWN_SHARE,
  POPULATION_GROWTH,
  REPAIR_DAYS,
  WATER_POINT_DOWN_SHARE,
  WATER_POINT_DOWN_SHARE_BY_COUNTRY,
  WALKING_SPEED_M_PER_S,
  growthRateForTown,
  householdSize,
  meanDaysBetweenBreakdowns,
  populationGrowthRate,
  roundTripMinutes,
  weeklyBreakdownProbability,
  type Rate,
} from "@/lib/config/behaviour";
import { servicePolygon } from "@/lib/providers/worldpop";
import { EMPTY_OSM, type CandidateFeatures } from "@/lib/types";
import {
  estimatePopulationServed,
  populationDisagreement,
  type PopulationArgs,
} from "@/lib/geospatial/population";

const TOWN: TownRef = {
  slug: "kisumu-kenya",
  name: "Kisumu",
  region: "Kisumu County",
  country: "Kenya",
  displayName: "Kisumu, Kisumu County, Kenya",
  center: [34.75, -0.1],
  bbox: [34.58, -0.18, 34.88, 0.02],
};

function raw(overrides: Partial<RawEvidence> = {}): RawEvidence {
  return {
    category: "hydrogeology",
    title: "Hydrogeology of Kenya",
    url: "https://www.bgs.ac.uk/africa/kenya",
    highlights: ["Basement aquifers near Kisumu yield 0.5 to 2 litres per second. Drilling success varies."],
    ...overrides,
  };
}

function loadDemoRun(slug: string): AnalysisRun {
  return JSON.parse(readFileSync(path.join(process.cwd(), "data", "demo", `${slug}.json`), "utf8")) as AnalysisRun;
}

// ---------------------------------------------------------------------------

describe("countryIso2", () => {
  test("maps names, aliases and codes", () => {
    assert.equal(countryIso2("Kenya"), "KE");
    assert.equal(countryIso2("  Côte d’Ivoire "), "CI");
    assert.equal(countryIso2("ug"), "UG");
    assert.equal(countryIso2("Atlantis"), undefined);
    assert.equal(countryIso2(undefined), undefined);
  });

  test("maps names and codes to ISO3 for WPdx", () => {
    assert.equal(countryIso3("Uganda"), "UGA");
    assert.equal(countryIso3("GH"), "GHA");
    assert.equal(countryIso3("ken"), "KEN");
    assert.equal(countryIso3("XYZ"), undefined);
    assert.equal(countryIso3(undefined), undefined);
  });
});

describe("regional scan (WPdx)", () => {
  test("functionality comes from status_clean categories", () => {
    assert.equal(classifyStatus("Functional"), "working");
    assert.equal(classifyStatus("Functional, needs repair"), "needs_repair");
    assert.equal(classifyStatus("Functional, not in use"), "idle");
    assert.equal(classifyStatus("Non-Functional"), "broken");
    assert.equal(classifyStatus("Non-Functional, dry season"), "seasonal");
    assert.equal(classifyStatus("Abandoned/Decommissioned"), "abandoned");
    assert.equal(classifyStatus("Other"), "unknown");
    assert.equal(classifyStatus(undefined), "unknown");
  });

  test("parses Socrata string aggregates and drops unusable rows", () => {
    const rows = parseDistrictRows([
      { clean_adm1: "Northern", clean_adm2: "Gulu", source: "CWSA", status_clean: "Non-Functional", n: "20", gain: "4000.4", lat: "2.9", lon: "32.4", latest: "2023-01-01T00:00:00.000" },
      { clean_adm2: "NoSource", n: "2" },
      { clean_adm2: "", n: "3" },
      { clean_adm2: "Empty", n: "0" },
      "junk",
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].source, "Unknown source");
    assert.deepEqual(rows[0], {
      region: "Northern",
      district: "Gulu",
      source: "CWSA",
      status: "broken",
      count: 20,
      wouldRegainAccess: 4000.4,
      lat: 2.9,
      lon: 32.4,
      latestReport: "2023-01-01",
    });
    assert.deepEqual(parseDistrictRows({ error: true }), []);
  });

  const ASOF = new Date("2026-09-15T00:00:00Z");
  const row = (over: Partial<DistrictStatusRow>): DistrictStatusRow => ({
    region: "Northern",
    district: "Gulu",
    source: "MWE",
    status: "working",
    count: 1,
    wouldRegainAccess: 0,
    lat: null,
    lon: null,
    latestReport: null,
    ...over,
  });
  const rows = [
    row({ status: "working", count: 80, lat: 2.8, lon: 32.3, latestReport: "2022-06-01" }),
    row({ status: "broken", count: 20, wouldRegainAccess: 4000.4, lat: 2.9, lon: 32.4, latestReport: "2023-01-01" }),
    row({ status: "unknown", count: 10 }),
    row({ region: "Western", district: "Hoima", status: "seasonal", count: 5, wouldRegainAccess: 6000, lat: 1.4, lon: 31.3 }),
    row({ region: "Western", district: "Hoima", status: "working", count: 15, lat: 1.4, lon: 31.3 }),
  ];

  test("rolls status groups up per district", () => {
    const [hoima, gulu] = rollupDistricts(rows, ASOF);
    assert.equal(gulu.district, "Gulu");
    assert.equal(gulu.waterPoints.total, 110);
    assert.equal(gulu.notWorkingShare, 0.2); // 20 broken of 100 with a known status
    assert.equal(gulu.wouldRegainAccess, 4000);
    assert.deepEqual(gulu.center, [32.32, 2.82]); // weighted by point count
    assert.equal(gulu.latestReport, "2023-01-01");
    assert.deepEqual(gulu.sources, [{ name: "MWE", points: 110 }]);
    assert.deepEqual(gulu.flags, []);
    assert.equal(hoima.notWorkingShare, 0.25);
    assert.deepEqual(hoima.flags, ["thin_sample", "stale"]); // 20 points, no dated report
  });

  test("flags stale districts against the scan date", () => {
    const old = [row({ district: "Old", count: 40, latestReport: "2014-01-17" })];
    assert.deepEqual(rollupDistricts(old, ASOF)[0].flags, ["stale"]); // 2014 < 2026 - 8
    assert.deepEqual(rollupDistricts(old, new Date("2020-01-01T00:00:00Z"))[0].flags, []);
  });

  test("ranks by people who would regain access, then share not working", () => {
    assert.deepEqual(rollupDistricts(rows, ASOF).map((d) => [d.rank, d.district]), [[1, "Hoima"], [2, "Gulu"]]);
    const tied = [
      row({ district: "A", status: "broken", count: 1, wouldRegainAccess: 100 }),
      row({ district: "A", status: "working", count: 3 }),
      row({ district: "B", status: "broken", count: 1, wouldRegainAccess: 100 }),
      row({ district: "B", status: "working", count: 1 }),
    ];
    assert.deepEqual(rollupDistricts(tied, ASOF).map((d) => d.district), ["B", "A"]);
    assert.deepEqual(rollupDistricts([...rows].reverse(), ASOF), rollupDistricts(rows, ASOF));
  });

  test("a survey of broken points only is flagged and ranked after the rest", () => {
    const skewed = [
      ...rows,
      row({ district: "Jomoro", source: "CWSA", status: "broken", count: 132, wouldRegainAccess: 94770, latestReport: "2025-05-02" }),
    ];
    const ranked = rollupDistricts(skewed, ASOF);
    const jomoro = ranked.find((d) => d.district === "Jomoro")!;
    assert.deepEqual(jomoro.flags, ["one_sided_survey"]);
    assert.equal(jomoro.rank, 3); // most people, but last: 100% broken means a partial survey
    assert.deepEqual(jomoro.sources, [{ name: "CWSA", points: 132 }]);
  });

  test("scan totals add up and carry their limitations", () => {
    const scan = buildRegionalScan({ country: "Uganda", iso3: "UGA", rows, retrievedAt: new Date("2026-09-15T00:00:00Z") });
    assert.equal(scan.totals.total, 130);
    assert.equal(scan.totals.wouldRegainAccess, 10000);
    assert.equal(scan.totals.districts, 2);
    assert.equal(scan.retrievedAt, "2026-09-15T00:00:00.000Z");
    assert.ok(scan.limitations.some((l) => /coverage/.test(l)));
  });
});

describe("Exa queries", () => {
  test("town tier restricts only need and hydrogeology to authoritative domains", () => {
    const specs = buildQueries(TOWN, "town");
    assert.deepEqual(specs.map((s) => s.category), ["water_need", "hydrogeology", "environment", "infrastructure"]);
    const restricted = specs.filter((s) => s.restrictToAuthoritative).map((s) => s.category);
    assert.deepEqual(restricted, ["water_need", "hydrogeology"]);
    for (const s of specs) assert.match(s.query, /Kisumu, Kisumu County, Kenya/);
  });

  test("broad tier widens to region and country, never restricted", () => {
    const specs = buildQueries(TOWN, "broad");
    assert.equal(specs.length, 4);
    for (const s of specs) {
      assert.match(s.query, /Kisumu County, Kenya/);
      assert.doesNotMatch(s.query, /Kisumu, Kisumu County/);
      assert.equal(s.restrictToAuthoritative, false);
    }
  });

  test("no broad tier without a country", () => {
    assert.deepEqual(buildQueries({ ...TOWN, country: undefined }, "broad"), []);
  });

  test("merge interleaves categories and dedupes by normalised URL", () => {
    const a = [raw({ url: "https://www.x.org/a/" }), raw({ url: "https://x.org/b" }), raw({ url: "https://x.org/c" })];
    const b = [raw({ category: "environment", url: "http://x.org/a" }), raw({ category: "environment", url: "https://y.org/1" })];
    const merged = mergeEvidence([a, b]);
    assert.deepEqual(merged.map((m) => urlKey(m.url)), ["x.org/a", "x.org/b", "y.org/1", "x.org/c"]);
    assert.equal(mergeEvidence([a, b], 2).length, 2);
  });

  test("parseHits keeps only http hits with content and trims dates", () => {
    const hits = parseHits({
      results: [
        { url: "https://ok.org", title: "OK", highlights: ["text"], publishedDate: "2021-04-05T00:00:00.000Z" },
        { url: "ftp://nope.org", highlights: ["text"] },
        { url: "https://empty.org", highlights: [] },
        { url: "https://earthwise-staging.bgs.ac.uk/x", title: "Mirror", highlights: ["text"] },
        "garbage",
      ],
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].publishedDate, "2021-04-05");
    assert.deepEqual(parseHits(null), []);
  });

  test("reports no_key without touching the network", async () => {
    const saved = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    try {
      const res = await searchEvidenceDetailed(TOWN);
      assert.equal(res.status, "no_key");
      assert.deepEqual(res.items, []);
    } finally {
      if (saved !== undefined) process.env.EXA_API_KEY = saved;
    }
  });
});

describe("deterministic structuring", () => {
  test("publisher and tier come from the hostname", () => {
    assert.equal(publisherFor("https://kenya.wateraid.org/x"), "WaterAid");
    assert.equal(publisherFor("https://www.mwe.go.ug/report"), "Uganda Ministry of Water and Environment");
    assert.equal(publisherFor("https://blog.example.com/p"), "blog.example.com");
    assert.equal(sourceTier("https://www.who.int/x"), "authoritative");
    assert.equal(sourceTier("https://water.go.ke/x"), "officialOrAcademic");
    assert.equal(sourceTier("https://uonbi.ac.ke/x"), "officialOrAcademic");
    assert.equal(sourceTier("https://news.example.com/x"), "other");
    assert.equal(publisherFor("https://doi.org/10.1111/x"), "Journal article (via DOI)");
    assert.equal(sourceTier("https://doi.org/10.1111/x"), "officialOrAcademic");
    assert.equal(publisherFor("https://city.kisumu.go.ke/2025/a"), "City of Kisumu");
    assert.equal(publisherFor("https://www.kisumu.go.ke/a"), "County Government of Kisumu");
  });

  test("generic, URL and filename titles become readable", () => {
    assert.equal(
      cleanTitle("World Bank Document", "https://documents1.worldbank.org/x", "World Bank", "water_need"),
      "World Bank — water access document",
    );
    const url = "https://reliefweb.int/attachments/abc";
    assert.equal(cleanTitle(url, url, "ReliefWeb (UN OCHA)", "water_need"), "ReliefWeb (UN OCHA) — water access document");
    assert.equal(cleanTitle("GHA_GLAAS Country Highlight_25Nov2019_final", "u", "WHO", "water_need"), "GHA GLAAS Country Highlight 25Nov2019 final");
    assert.equal(cleanTitle("Hydrogeology of Kenya - MediaWiki - BGS Earthwise", "u", "BGS", "hydrogeology"), "Hydrogeology of Kenya - BGS Earthwise");
    assert.equal(cleanTitle("Gulu water project", "u", "X", "infrastructure"), "Gulu water project");
  });

  test("canonical publisher prefers the table, else the given reading", () => {
    assert.equal(canonicalPublisher("https://link.springer.com/article/1", "link.springer.com"), "Springer");
    assert.equal(canonicalPublisher("https://obscure.example.org/x", "Obscure Institute"), "Obscure Institute");
    assert.equal(canonicalPublisher("https://obscure.example.org/x", "  "), "obscure.example.org");
  });

  test("findings quote the excerpt, carry no score impact and stay under the ceiling", () => {
    const findings = structureDeterministically(
      [raw(), raw({ url: "https://news.example.com/a", highlights: ["Unrelated town."] })],
      "Kisumu",
    );
    assert.equal(findings[0].id, "f00");
    assert.match(findings[0].summary, /^“Basement aquifers near Kisumu/);
    assert.equal(findings[0].sourceName, "British Geological Survey");
    assert.equal(findings[0].confidence, 0.65); // authoritative + names the town, at the ceiling
    assert.equal(findings[1].confidence, 0.35);
    for (const f of findings) assert.equal(f.scoreImpact, undefined);
  });

  test("leadingSentences cuts on sentence boundaries", () => {
    const text = "First sentence is here. Second sentence is also here. Third one would overflow the limit entirely.";
    assert.equal(leadingSentences(text, 60), "First sentence is here. Second sentence is also here.");
    assert.equal(leadingSentences("Short.", 60), "Short.");
  });
});

describe("evidence snapshots", () => {
  test("committed demo snapshots load with canonical publisher names", async () => {
    for (const slug of ["kisumu-kenya", "tamale-ghana"]) {
      const snap = await loadEvidenceSnapshot(slug);
      assert.ok(snap && snap.findings.length > 0, slug);
      for (const f of snap.findings) {
        assert.equal(f.sourceName, canonicalPublisher(f.sourceUrl, f.sourceName), f.sourceUrl);
        assert.doesNotMatch(f.sourceName, /^(link\.springer\.com|documents1\.worldbank\.org|earthwise\.bgs\.ac\.uk)$/);
      }
    }
  });
});

describe("partners", () => {
  test("organisation names come from the title segment matching the host", () => {
    assert.equal(organisationName("Uganda | WaterAid", "wateraid.org"), "WaterAid");
    assert.equal(organisationName("Home - Water For People", "waterforpeople.org"), "Water For People");
    // A country segment that happens to appear in the domain is not the name.
    assert.equal(organisationName("Kenya | Home", "lwikenya.com"), "lwikenya.com");
    assert.equal(organisationName("Kenya | Living Water International", "lwikenya.com"), "Living Water International");
    assert.equal(rootDomain("kenya.wateraid.org"), "wateraid.org");
    assert.equal(rootDomain("kiwasco.co.ke"), "kiwasco.co.ke");
  });

  test("search hits skip non-organisations, dedupe by domain and tag focus", () => {
    const found = partnersFromHits(
      [
        { url: "https://en.wikipedia.org/wiki/Water", title: "Water", highlights: ["x"] },
        { url: "https://drillers.org/", title: "Drillers Trust", highlights: ["We drill boreholes with solar pumps."] },
        { url: "https://drillers.org/about", title: "About", highlights: ["dup"] },
        { url: "https://exa.ai/library/organization/x", title: "Milton Foundation", highlights: ["boreholes"] },
      ],
      "KE",
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].source, "search");
    assert.equal(found[0].kind, "funder");
    assert.deepEqual(found[0].focus, ["boreholes", "solar_pumping"]);
  });

  test("merge puts country-verified first, drops search duplicates, ends with global", () => {
    const verified = verifiedPartnersFor("KE");
    const dup: Partner = { ...verified[0], id: "search-dup", source: "search" };
    const fresh: Partner = { ...dup, id: "search-new", url: "https://new-org.org/" };
    const merged = mergePartners(verified, [dup, fresh], 100);
    assert.equal(merged[0].country, "KE");
    assert.ok(!merged.some((p) => p.id === "search-dup"));
    const freshAt = merged.findIndex((p) => p.id === "search-new");
    const firstGlobal = merged.findIndex((p) => p.country === "global");
    assert.ok(freshAt > 0 && freshAt < firstGlobal);
    assert.equal(mergePartners(verified, [fresh], 5).length, 5);
  });

  test("verified list is well formed", () => {
    const ids = new Set<string>();
    for (const p of VERIFIED_PARTNERS) {
      assert.match(p.url, /^https:\/\//, p.name);
      if (p.countryUrl) assert.match(p.countryUrl, /^https:\/\//, p.name);
      assert.ok(p.focus.length > 0, p.name);
      assert.ok(p.description.length > 20 && p.description.length < 200, p.name);
      assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
      ids.add(p.id);
    }
    for (const iso of ["KE", "UG", "GH"]) {
      assert.ok(verifiedPartnersFor(iso).filter((p) => p.country === iso).length >= 5, iso);
    }
    assert.ok(verifiedPartnersFor(undefined).every((p) => p.country === "global"));
  });

  test("discovery without a key returns the verified list", async () => {
    const saved = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    try {
      const res = await discoverPartners("Uganda");
      assert.equal(res.status, "no_key");
      assert.deepEqual(res.partners, verifiedPartnersFor("UG"));
    } finally {
      if (saved !== undefined) process.env.EXA_API_KEY = saved;
    }
  });
});

describe("cost per person", () => {
  const rec = {
    cost: { totalLow: 62000, totalHigh: 139000 },
    peopleServedLow: 1000,
    peopleServedHigh: 2000,
  } as InfrastructureRecommendation;

  test("widest honest range: cheap/most to dear/fewest", () => {
    const cpp = costPerPersonServed(rec);
    assert.deepEqual(
      { low: cpp?.low, mid: cpp?.mid, high: cpp?.high },
      { low: 31, mid: 67, high: 139 },
    );
    assert.match(cpp?.basis ?? "", /Excludes operation and maintenance/);
  });

  test("null when nobody is served or there is no recommendation", () => {
    assert.equal(costPerPersonServed({ ...rec, peopleServedLow: 0 }), null);
    assert.equal(costPerPersonServed(null), null);
  });
});

describe("project brief", () => {
  const run = loadDemoRun("kisumu-kenya");

  test("is deterministic and covers every section", () => {
    const md = buildProjectBrief(run);
    assert.equal(md, buildProjectBrief(run));
    for (const heading of [
      "# Water point project brief — Kisumu",
      "## Summary",
      "## Proposed intervention",
      "### Cost breakdown",
      "## Population estimate",
      "## Evidence",
      "## Data sources",
    ]) {
      assert.ok(md.includes(heading), heading);
    }
    assert.match(md, /Cost per person served/);
    // The brief names where its evidence came from, whichever rung of the chain the snapshot used.
    assert.match(md, /bundled reference sources|a saved earlier live Exa search|live Exa search during this run/);
  });

  test("reads figures from the run rather than recomputing them", () => {
    const md = buildProjectBrief(run);
    const rec = run.recommendation!;
    assert.ok(md.includes(`$${rec.cost.totalLow.toLocaleString("en-US")} – $${rec.cost.totalHigh.toLocaleString("en-US")}`));
    for (const f of run.findings) assert.ok(md.includes(f.sourceUrl), f.id);
  });

  test("escapes table-breaking characters in partner names", () => {
    const partner: Partner = { ...verifiedPartnersFor("KE")[0], name: "A | B" };
    const md = buildProjectBrief(run, { partners: [partner] });
    assert.ok(md.includes("[A \\| B]"));
  });

  test("renders a brief when no site survived", () => {
    const md = buildProjectBrief({ ...run, winnerId: null, recommendation: null, whyThisSite: [], alternatives: [] });
    assert.match(md, /No viable site was found/);
    assert.doesNotMatch(md, /Cost breakdown/);
  });

  test("appends extra sections", () => {
    const md = buildProjectBrief(run, { extraSections: [{ title: "Simulation", body: "Held in 9 of 10 futures." }] });
    assert.match(md, /## Simulation\n\nHeld in 9 of 10 futures\./);
  });
});

describe("behaviour rates", () => {
  const all: [string, Rate][] = [
    ...Object.entries(POPULATION_GROWTH),
    ...Object.entries(HOUSEHOLD_SIZE),
    ...Object.entries(REPAIR_DAYS),
    ...Object.entries(DROUGHT_FUNCTIONALITY),
    ...Object.entries(CITY_GROWTH),
    ...(Object.entries(WATER_POINT_DOWN_SHARE_BY_COUNTRY) as [string, Rate][]),
    ["downShare", WATER_POINT_DOWN_SHARE],
    ["motorised", MOTORISED_SCHEME_DOWN_SHARE],
    ["walking", WALKING_SPEED_M_PER_S],
  ];

  test("town growth uses a sourced city rate, else the national one", () => {
    // Kisumu County: 968,909 (2009) → 1,155,574 (2019).
    const cagr = ((1155574 / 968909) ** (1 / 10) - 1) * 100;
    assert.ok(Math.abs(cagr - CITY_GROWTH["kisumu-kenya"].central) < 0.01, String(cagr));
    assert.equal(growthRateForTown("kisumu-kenya", "KE"), CITY_GROWTH["kisumu-kenya"]);
    // Boundary changes make city rates invalid for these two.
    assert.equal(growthRateForTown("tamale-ghana", "GH"), POPULATION_GROWTH.GH);
    assert.equal(growthRateForTown("gulu-uganda", "UG"), POPULATION_GROWTH.UG);
    assert.equal(growthRateForTown(undefined, undefined), POPULATION_GROWTH.SSA);
  });

  test("motorised schemes are down more often and for longer than handpumps", () => {
    assert.ok(MOTORISED_SCHEME_DOWN_SHARE.central > WATER_POINT_DOWN_SHARE.central);
    assert.ok(REPAIR_DAYS.motorisedCommunityManaged.low > REPAIR_DAYS.communityManaged.central);
  });

  test("every rate is ordered and cited", () => {
    for (const [name, r] of all) {
      assert.ok(r.low <= r.central && r.central <= r.high, name);
      assert.match(r.url, /^https:\/\//, name);
      assert.ok(r.source.length > 10, name);
    }
    assert.equal(DEMAND_LITERS_PER_PERSON_DAY.basic.value, 20);
  });

  test("unknown countries fall back explicitly", () => {
    assert.equal(populationGrowthRate("ke"), POPULATION_GROWTH.KE);
    assert.equal(populationGrowthRate("ZZ"), POPULATION_GROWTH.SSA);
    assert.equal(householdSize("GH").central, 3.6);
    assert.match(householdSize(undefined).note ?? "", /fallback/);
  });

  test("breakdown frequency is derived from downtime share and repair time", () => {
    const mtbf = meanDaysBetweenBreakdowns(0.25, 43);
    assert.ok(Math.abs(mtbf - 129) < 1e-9);
    const weekly = weeklyBreakdownProbability(0.25, 43);
    assert.ok(weekly > 0.05 && weekly < 0.06);
    // Faster repair at the same share implies more frequent failures.
    assert.ok(weeklyBreakdownProbability(0.25, 2) > weekly);
  });

  test("a 500 m tap trip fits inside the JMP 30-minute basic service", () => {
    const t = roundTripMinutes({ distanceM: 500 });
    assert.ok(t > 19 && t < 21, String(t));
  });
});

describe("population: WorldPop primary", () => {
  // 10 buildings within 400 m → 63 within 1 km → 265–403 people by building density.
  const mappedArgs: PopulationArgs = {
    town: TOWN,
    osm: { ...EMPTY_OSM, degraded: false },
    winnerFeatures: { nearbyBuildingCount: 10, nearbyCommunityFacilityCount: 0 } as CandidateFeatures,
    totalBuildingsInArea: 100,
    serviceRadiusM: 1000,
  };
  const worldpop = { people: 1000, year: 2020, dataset: "wpgppop", source: "WorldPop test" };
  const growth = { low: 1, central: 2, high: 3, source: "test rate" };

  test("falls back to mapped data without WorldPop", () => {
    const p = estimatePopulationServed(mappedArgs);
    assert.equal(p.method, "building_density_proxy");
    assert.deepEqual([p.rangeLow, p.rangeHigh], [265, 403]);
    assert.equal(populationDisagreement(p), null);
  });

  test("uses WorldPop when available, projected with the growth range and a ±20% band", () => {
    const p = estimatePopulationServed({ ...mappedArgs, worldpop, growth, asOfYear: 2026 });
    assert.equal(p.method, "worldpop_gridded");
    assert.equal(p.peopleServed, 1126); // 1000 × 1.02^6
    assert.equal(p.rangeLow, 849); // 1000 × 1.01^6 × 0.8
    assert.equal(p.rangeHigh, 1433); // 1000 × 1.03^6 × 1.2
    assert.deepEqual(p.worldpop, worldpop);
    assert.deepEqual([p.alternative?.method, p.alternative?.rangeLow, p.alternative?.rangeHigh], ["building_density_proxy", 265, 403]);
    assert.match(p.methodLabel, /projected 6 years to 2026/);
  });

  test("no projection when the target year is the WorldPop year", () => {
    const p = estimatePopulationServed({ ...mappedArgs, worldpop, growth, asOfYear: 2020 });
    assert.deepEqual([p.peopleServed, p.rangeLow, p.rangeHigh], [1000, 800, 1200]);
    assert.doesNotMatch(p.methodLabel, /projected/);
  });

  test("flags a gap wider than 2× between WorldPop and mapped data", () => {
    const p = estimatePopulationServed({ ...mappedArgs, worldpop, growth, asOfYear: 2026 });
    assert.equal(populationDisagreement(p), 3.4); // 1126 vs midpoint 334
    assert.ok(p.limitations.some((l) => /differs by 3\.4×/.test(l)));
    const close = estimatePopulationServed({ ...mappedArgs, worldpop: { ...worldpop, people: 400 }, asOfYear: 2020 });
    assert.equal(populationDisagreement(close), null);
  });
});

describe("evidence signals", () => {
  const finding = (
    id: string,
    factor: ScoreFactor,
    direction: "increase" | "decrease",
    magnitude: number,
    confidence = 0.9,
  ): EvidenceFinding => ({
    id,
    category: "hydrogeology",
    title: id,
    summary: id,
    sourceName: "Source",
    sourceUrl: `https://source.org/${id}`,
    confidence,
    scoreImpact: { factor, direction, magnitude },
  });

  test("many agreeing sources cannot pin a factor to the bound", () => {
    const many = Array.from({ length: 12 }, (_, i) => finding(`f${i}`, "risk", "increase", 0.3));
    const up = aggregateSignals(many);
    assert.ok(up.risk > 0.8 && up.risk < 0.5 + MAX_FACTOR_SHIFT, String(up.risk));
    const down = aggregateSignals(
      many.map((f) => ({ ...f, scoreImpact: { ...f.scoreImpact!, direction: "decrease" as const } })),
    );
    assert.ok(Math.abs(0.5 - down.risk - (up.risk - 0.5)) < 1e-12);
  });

  test("a single modest source moves its factor almost linearly", () => {
    const s = aggregateSignals([finding("f0", "groundwater", "increase", 0.1, 0.5)]);
    assert.ok(Math.abs(s.groundwater - 0.55) < 0.002, String(s.groundwater));
  });

  test("opposing sources cancel and untouched factors stay at baseline", () => {
    const s = aggregateSignals([finding("f0", "need", "increase", 0.2), finding("f1", "need", "decrease", 0.2)]);
    assert.equal(s.need, 0.5);
    assert.equal(s.cost, 0.5);
    assert.deepEqual(s.contributors.need, ["f0", "f1"]);
  });

  test("no findings gives the neutral signals", () => {
    assert.deepEqual(aggregateSignals([]), NEUTRAL_SIGNALS);
  });
});

describe("WorldPop polygon", () => {
  test("is a closed ring of rounded coordinates around the centre", () => {
    const poly = servicePolygon([34.75, -0.1], 1000, 16);
    const ring = poly.coordinates[0];
    assert.equal(poly.type, "Polygon");
    assert.equal(ring.length, 17);
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    for (const [lon, lat] of ring) {
      assert.ok(Math.abs(lon - 34.75) < 0.01 && Math.abs(lat + 0.1) < 0.01);
      assert.equal(lon, Math.round(lon * 1e5) / 1e5);
    }
  });
});
