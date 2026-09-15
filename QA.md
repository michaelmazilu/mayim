# Mayim — Ship QA checklist

Run this on the live Vercel deployment (mayimgc.vercel.app) before demo day, and
again after any env var or dependency change. Each row lists the exact case,
what to check, and the failure mode it's guarding against.

## 1. Presets (Kisumu, Gulu, Tamale)

| Check | What "pass" looks like | Corner case it catches |
| --- | --- | --- |
| Load each of the 3 demo towns from the landing page chips | All 6 analysis tracks complete (6/6), a winning site renders, all 5 tabs (Overview/Why/Evidence/Alternatives/Validation) populate | A town whose cached run predates a schema change (new fields Michael/Eric added) and silently renders blank sections |
| Compare a preset's live run vs its `data/demo/*.json` cached run | Same `winnerId`, same candidate count — determinism means identical inputs must give identical output | `Math.random()` or a non-deterministic sort creeping into `lib/scoring` or `lib/geospatial` |
| Re-run a preset immediately after the first run | Second run's provenance-relevant costs/output match the first run bit-for-bit | Any caching layer or timestamp field bleeding into the deterministic output |

## 2. Sparse-OSM town

Pick a genuinely small, sparsely-mapped place — not one of the 3 presets — e.g.
a rural town with minimal OSM coverage (test with something like a small town
in a country with low OSM mapping density; confirm via a quick check on
openstreetmap.org that it has few roads/buildings first).

| Check | What "pass" looks like | Corner case it catches |
| --- | --- | --- |
| Candidate count when OSM returns very few features | App still returns a ranked result, or clearly reports "No viable sites" — never crashes | `candidateCount` divide-by-zero or empty-array indexing in `lib/scoring/score.ts` (note `relativeCountScore` guards against `observedMax = 0` — confirm this in practice, not just in code) |
| Water-point-absent messaging | Shows the exact honesty-constraint copy: "No mapped water points were found in OpenStreetMap. This does not prove that none exist." | A silent fallback that implies confidently there's no existing service |
| `osm.degraded` path | Track shows "degraded" status with the `osm.note` message, not a generic error | Overpass returning a valid-but-empty response being treated as a *failure* instead of *sparse data* |

## 3. Big city

Pick a dense metro area (a large capital city with heavy OSM mapping).

| Check | What "pass" looks like | Corner case it catches |
| --- | --- | --- |
| Overpass payload caps | Response stays fast and doesn't time out; check dev tools network tab for the Overpass call duration vs the 25s `TIMEOUT_MS` in `overpass.ts` | A city with >4000 buildings / >1500 roads hitting the subsample caps and either erroring or silently truncating in a way that biases the winner toward one map corner |
| `analyze` route duration end-to-end | Full run completes within the 120s `maxDuration` on `app/api/analyze/route.ts` | A big city pushing candidate generation (150–500 sites) + scoring past the Vercel function timeout — **this is the single highest-risk item on the whole list, test it explicitly, not just assume the cap is fine** |
| Rendering 500 candidates on the map | Map stays responsive (no dropped frames / frozen tab) when all candidates + exclusions render | Client-side render cost scaling badly with candidate count on a live demo machine, not just in dev |

## 4. No-key mode

Temporarily unset (or use a Vercel Preview deployment without) `EXA_API_KEY`,
`OPENAI_API_KEY`, and `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` one at a time, then all
together.

| Check | What "pass" looks like | Corner case it catches |
| --- | --- | --- |
| No Mapbox token | Map area shows the documented instruction panel, not a crash or blank white box | A component assuming `mapboxgl` initializes successfully and throwing on `undefined` token |
| No Exa key | `dataSources` shows `"Exa research": { ok: false, detail: "Not configured — bundled evidence" }`; narrative still generates from bundled evidence | Silent failure that looks identical to a live run — the demo must visibly disclose degraded mode, per the project's own "honesty constraints" |
| No OpenAI key | Narrative falls back to deterministic/bundled text, `narrativeSource` reflects it, cost/output numbers are unaffected (they're formula-driven, not LLM-driven per README) | The LLM being silently on the critical path for a number it should never touch |
| All keys unset simultaneously (the actual worst-case demo-day scenario — WiFi dies, a key gets revoked) | A full analysis run still completes end-to-end on bundled reference evidence for the 3 demo towns | This is your literal backup plan — test it as a first-class path, not an afterthought |

## 5. Phone

Test on an actual phone if possible; otherwise DevTools device emulation at
both a small (iPhone SE, 375px) and larger (390–430px) width.

| Check | What "pass" looks like | Corner case it catches |
| --- | --- | --- |
| Search + preset chips | Fully tappable, no horizontal scroll, text doesn't clip | Fixed-width layout from desktop-first CSS |
| Map + analysis panel layout | Panel doesn't cover the whole map permanently; there's a way to see both | A two-column desktop layout that never collapses to stacked on narrow viewports |
| Live analysis feed while scrolling | Tapping a track row doesn't fight with page scroll | Touch event handling for hover-based interactions ported straight from desktop |
| Tab bar (Overview/Why/Evidence/Alternatives/Validation) | All 5 tabs reachable and readable | Tab bar overflow with no scroll/swipe affordance on narrow screens |

## 6. Both themes

Use the `ThemeSwitch` control (cycles light → dark → auto).

| Check | What "pass" looks like | Corner case it catches |
| --- | --- | --- |
| First paint in each theme | No white flash in dark mode, no unstyled flash in light mode | The inline bootstrap script (mentioned in `ThemeSwitch.tsx` comments) not actually matching what the React layer applies post-hydration |
| Map basemap in dark mode | CARTO dark tiles load (`dark_all`/`dark_only_labels` per `AquaMap.tsx`), not light tiles with a dark page around them | Theme token wired to the page chrome but not passed through to the map layer's tile selection |
| "auto" theme + OS theme change mid-session | Page follows the OS theme live without a manual reload | `color-scheme` CSS property or the `mayim:themechange` event not firing on `prefers-color-scheme` change |
| localStorage unavailable (private/incognito window) | Theme still applies for the session, just doesn't persist — no thrown error | Missing try/catch around `localStorage.setItem` (the code comments say this is handled — verify it actually is in a real private window) |

## Corner cases that cut across every row above

- **Cold start on Vercel**: the very first request after a deploy or period of inactivity may be slower — time it separately from a "warm" run so you don't mistake serverless cold-start latency for a real performance regression.
- **Two demo towns run back-to-back with different provenance** (one live, one falling back to demo) — verify the UI's provenance badge (`live` / `cache` / `demo` / `partial`) actually changes between them and isn't stuck from the first run.
- **Slow/flaky network mid-run** — throttle to "Slow 3G" in DevTools on one run and confirm the SSE stream degrades gracefully (retries or clearly reports the failure) instead of hanging the UI forever.
- **Concurrent runs** — open the app in two tabs and start different towns at once; confirm they don't share state or clobber each other's cached-run writes.

## CI on PRs

`.github/workflows/ci.yml` runs lint, typecheck, unit tests, and a build on
every PR and push to `main`. It does **not** run `evidence:refresh` or
`scan:refresh` (both need live `EXA_API_KEY` / network access to external data
sources and are meant to be run manually, then their output committed) — CI
intentionally proves the app builds and passes tests in the same no-key state
QA section 4 covers above.

## Merge captain

One person (rotate if you want, but pick one per PR) is responsible for:

1. Confirming CI is green on the PR before merging — never merge on red or on "I'll fix it after."
2. Pulling `main` and smoke-testing at least one preset town locally (or on the
   PR's Vercel preview deployment) before merging anything that touches
   `lib/pipeline.ts`, `lib/scoring/`, or the API routes.
3. Re-running the QA sparse-OSM/big-city/no-key checks above after any PR that
   changes `lib/providers/`, `lib/evidence/`, or the caching layer — those are
   exactly the areas most likely to silently break a degraded-mode path.
4. Owning conflict resolution when two people touch `data/demo/*.json` or
   `data/evidence/*.json` in the same window — these are generated files, so
   the fix is usually "regenerate, don't hand-merge the diff."
