/**
 * Town-specific simulation rates read from retrieved evidence.
 *
 * Run: node --import tsx --test lib/__tests__/popsim-rates.test.ts
 * No network: the OpenAI call is exercised against a stubbed fetch.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import type { TownRef } from "@/lib/types";
import type { RawEvidence } from "@/lib/evidence/exa";
import { BEHAVIOUR } from "@/lib/config/coefficients";
import { defaultRates, ratesFromShares } from "@/lib/popsim/engine";
import { deriveRates, extractRates, type ExtractedRates } from "@/lib/evidence/rates";

const RAW: RawEvidence[] = [
  {
    category: "infrastructure",
    title: "District WASH review",
    url: "https://example.org/wash",
    highlights: ["A 2021 survey found that 32% of handpumps were non-functional at the time of the visit."],
  },
  {
    category: "water_need",
    title: "Urban growth profile",
    url: "https://example.org/growth",
    highlights: ["The town's population grows at 4.1% per year, driven by migration."],
  },
  {
    category: "infrastructure",
    title: "Handpump maintenance study",
    url: "https://example.org/repairs",
    highlights: ["On average a broken handpump was repaired within six weeks."],
  },
];

const TOWN: TownRef = {
  slug: "testville-kenya",
  name: "Testville",
  region: "Test District",
  country: "Kenya",
  displayName: "Testville, Test District, Kenya",
  center: [34.7, -0.1],
  bbox: [34.6, -0.2, 34.8, 0],
};

/** The defaults' ratio of new-system to existing out-of-service share. */

type Field = ExtractedRates["sources"][number]["field"];

function extraction(overrides: Partial<ExtractedRates> = {}): ExtractedRates {
  return { nonFunctionalShare: null, annualGrowthRate: null, repairWeeks: null, sources: [], ...overrides };
}

/** A citation of the whole first highlight of RAW[index]. */
const cite = (field: Field, index: number) => ({ field, index, quote: RAW[index].highlights[0] });

describe("deriveRates", () => {
  test("null extraction keeps the planning defaults and says so in one note", () => {
    for (const ex of [null, extraction()]) {
      const r = deriveRates(ex, RAW);
      assert.deepEqual(r.rates, defaultRates());
      assert.equal(r.notes.length, 1);
      assert.match(r.notes[0], /labelled planning defaults/);
    }
  });

  test("cited values override the defaults and each note cites its quote, title and URL", () => {
    const ex = extraction({
      nonFunctionalShare: 0.32,
      annualGrowthRate: 0.041,
      repairWeeks: 6,
      sources: [
        { field: "nonFunctionalShare", index: 0, quote: "32% of handpumps were non-functional" },
        { field: "annualGrowthRate", index: 1, quote: "The town's population grows at 4.1% per year" },
        { field: "repairWeeks", index: 2, quote: "On average a broken handpump was repaired within six weeks." },
      ],
    });
    const r = deriveRates(ex, RAW);

    // Repair band [round(0.5 r), round(1.5 r)]. Evidence moves the existing points only: the new
    // system's breakdowns come from its hardware class and its maintenance, not from this share.
    assert.deepEqual(r.rates, {
      ...defaultRates(),
      shareExisting: 0.32,
      failExisting: ratesFromShares(0.32, 0, 3, 9, 0.041).failExisting,
      repairLow: 3,
      repairHigh: 9,
      growth: 0.041,
    });
    // Down share s with mean repair r weeks implies weekly failure s / (r (1 - s)).
    assert.ok(Math.abs(r.rates.failExisting - 0.32 / (6 * (1 - 0.32))) < 1e-12);
    assert.equal(r.rates.failProject, defaultRates().failProject);

    assert.equal(r.notes.length, 3);
    for (const s of ex.sources) {
      const doc = RAW[s.index];
      const note = r.notes.find((n) => n.includes(s.quote));
      assert.ok(note, `a note quotes the ${s.field} source`);
      assert.ok(note.includes(doc.title) && note.includes(doc.url), `the ${s.field} note names its document`);
    }
    assert.ok(r.notes.some((n) => n.includes("32%")));
    assert.ok(r.notes.some((n) => n.includes("4.1% a year")));
    assert.ok(r.notes.some((n) => n.includes("3 to 9 weeks")));
    assert.ok(!r.notes.some((n) => n.includes("planning defaults")));
  });

  test("a value is used only when a source for it points at a real document with a quote", () => {
    const ex = extraction({
      nonFunctionalShare: 0.4,
      annualGrowthRate: 0.041,
      repairWeeks: 10,
      sources: [
        { field: "nonFunctionalShare", index: 7, quote: "40% of points were broken" }, // no such document
        { field: "annualGrowthRate", index: 1, quote: "grows at 4.1% per year" },
        { field: "repairWeeks", index: 2, quote: "   " }, // empty quote
      ],
    });
    const r = deriveRates(ex, RAW);
    assert.deepEqual(r.rates, { ...defaultRates(), growth: 0.041 });
    assert.equal(r.notes.length, 1);
    assert.ok(r.notes[0].includes("https://example.org/growth"));

    const uncited = deriveRates(extraction({ nonFunctionalShare: 0.4, annualGrowthRate: 0.05, repairWeeks: 10 }), RAW);
    assert.deepEqual(uncited.rates, defaultRates());
    assert.match(uncited.notes[0], /labelled planning defaults/);
  });

  test("out-of-range values are clamped, not trusted, and the notes say so", () => {
    const all = [cite("nonFunctionalShare", 0), cite("annualGrowthRate", 1), cite("repairWeeks", 2)];

    const high = deriveRates(
      extraction({ nonFunctionalShare: 0.99, annualGrowthRate: 0.5, repairWeeks: 400, sources: all }),
      RAW,
    );
    // Share capped at 0.6, growth at 0.08, repair at 26 weeks -> band [13, 39].
    assert.deepEqual(high.rates, {
      ...defaultRates(),
      shareExisting: 0.6,
      failExisting: ratesFromShares(0.6, 0, 13, 39, 0.08).failExisting,
      repairLow: 13,
      repairHigh: 39,
      growth: 0.08,
    });
    assert.equal(high.notes.length, 3);
    assert.ok(high.notes.every((n) => n.includes("limited to the accepted")));

    const low = deriveRates(
      extraction({ nonFunctionalShare: 0.01, annualGrowthRate: -0.02, repairWeeks: 0.2, sources: all }),
      RAW,
    );
    // Share raised to 0.05, growth to 0, repair to 1 week -> band [1, 2].
    assert.deepEqual(low.rates, {
      ...defaultRates(),
      shareExisting: 0.05,
      failExisting: ratesFromShares(0.05, 0, 1, 2, 0).failExisting,
      repairLow: 1,
      repairHigh: 2,
      growth: 0,
    });

    const junk = deriveRates(
      extraction({ nonFunctionalShare: Number.NaN, annualGrowthRate: Number.POSITIVE_INFINITY, sources: all }),
      RAW,
    );
    assert.deepEqual(junk.rates, defaultRates());
  });
});

describe("extractRates", () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedFetch = globalThis.fetch;
  const setFetch = (fn: (url: unknown, init?: RequestInit) => Promise<Response>) => {
    (globalThis as { fetch: unknown }).fetch = fn;
  };
  const reply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    globalThis.fetch = savedFetch;
  });

  test("returns null without an OpenAI key, without calling out", async () => {
    delete process.env.OPENAI_API_KEY;
    let calls = 0;
    setFetch(async () => {
      calls++;
      throw new Error("no network in tests");
    });
    assert.equal(await extractRates(TOWN, RAW), null);
    assert.equal(calls, 0);
  });

  test("returns null with no sources, without calling out", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let calls = 0;
    setFetch(async () => {
      calls++;
      throw new Error("no network in tests");
    });
    assert.equal(await extractRates(TOWN, []), null);
    assert.equal(calls, 0);
  });

  test("makes one strict json_schema call and keeps only values with a verified quote", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const bodies: unknown[] = [];
    const answer = {
      nonFunctionalShare: 32, // returned as a percentage
      annualGrowthRate: 0.041,
      repairWeeks: 6,
      sources: [
        { field: "nonFunctionalShare", index: 0, quote: "“32% of handpumps were non-functional at the time of the visit.”" },
        { field: "annualGrowthRate", index: 1, quote: "The population grows at 4.1% per year across the country." }, // not in the excerpt
        { field: "repairWeeks", index: 9, quote: "repaired within six weeks" }, // no such excerpt
      ],
    };
    setFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply(JSON.stringify(answer));
    });

    const out = await extractRates(TOWN, RAW);

    assert.equal(bodies.length, 1);
    const body = bodies[0] as {
      temperature: number;
      response_format: { type: string; json_schema: { name: string; strict: boolean } };
    };
    assert.equal(body.temperature, 0);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(out, {
      nonFunctionalShare: 0.32,
      annualGrowthRate: null,
      repairWeeks: null,
      sources: [
        { field: "nonFunctionalShare", index: 0, quote: "32% of handpumps were non-functional at the time of the visit." },
      ],
    });
  });

  test("accepts a quote with an elision and turns into rates end to end", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    setFetch(async () =>
      reply(
        JSON.stringify({
          nonFunctionalShare: null,
          annualGrowthRate: null,
          repairWeeks: 6,
          sources: [{ field: "repairWeeks", index: 2, quote: "a broken handpump ... within six weeks" }],
        }),
      ),
    );
    const out = await extractRates(TOWN, RAW);
    assert.ok(out);
    assert.equal(out.repairWeeks, 6);
    const r = deriveRates(out, RAW);
    assert.deepEqual(r.rates, ratesFromShares(BEHAVIOUR.nonFunctionalShare.existing, BEHAVIOUR.nonFunctionalShare.project, 3, 9, BEHAVIOUR.annualGrowthRate.value));
    assert.equal(r.notes.length, 1);
    assert.ok(r.notes[0].includes("Handpump maintenance study") && r.notes[0].includes("https://example.org/repairs"));
  });

  test("returns null when the call fails or the reply is malformed", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const failures: (() => Promise<Response>)[] = [
      async () => new Response("server error", { status: 500 }),
      async () => {
        throw new Error("network down");
      },
      async () => reply("not json"),
      async () => reply(JSON.stringify({ nonFunctionalShare: "a lot", sources: [] })),
    ];
    for (const failure of failures) {
      setFetch(failure);
      assert.equal(await extractRates(TOWN, RAW), null);
    }
  });

  test("a sourced base is used as-is without evidence and keeps the project's rates when evidence overrides", () => {
    const base = {
      rates: { ...defaultRates(), failProject: 0.021, projectRepairLow: 1, projectRepairHigh: 1, growth: 0.048 },
      notes: ["sourced base"],
    };
    assert.deepEqual(deriveRates(null, RAW, base), base);
    const r = deriveRates(extraction({ nonFunctionalShare: 0.3, annualGrowthRate: null, repairWeeks: null, sources: [cite("nonFunctionalShare", 0)] }), RAW, base);
    assert.equal(r.rates.shareExisting, 0.3);
    assert.equal(r.rates.failProject, 0.021);
    assert.equal(r.rates.projectRepairHigh, 1);
    assert.equal(r.rates.growth, 0.048);
    assert.ok(r.notes.includes("sourced base"));
  });
});
