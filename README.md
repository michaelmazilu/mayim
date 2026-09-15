# Mayim

**Finds the highest-leverage site for new clean-water infrastructure in an underserved town, then designs and costs it.**

Billions of dollars go into water and humanitarian development, yet more than 400 million people in Africa still lack access to basic drinking water (African Development Bank). The binding constraint is no longer intent — it is deciding *where* a new water point does the most good.

Mayim answers that one town at a time. Enter a name; it pulls live terrain, climate and OpenStreetMap data, researches institutional sources with **Exa**, screens hundreds of candidate sites against mapped constraints, ranks the survivors with a transparent deterministic model, and returns a costed conceptual design on satellite imagery — every number traceable to a formula or a source.

> Pre-feasibility screening. Field survey and licensed engineering are still required.

---

## Quick start

```bash
npm install
cp .env.example .env.local   # add a Mapbox token; Exa/OpenAI optional
npm run dev
```

Open http://localhost:3000 and search a town (try `Kisumu, Kenya`).

`npm run build` · `npm start` · `npm run lint` · `npm run typecheck` · `npm test` (99 unit tests) · `npm run evidence:refresh` (re-save live sources for the demo towns; needs `EXA_API_KEY`)

## What a run returns

Six analysis tracks stream live — water access, hydrogeology, existing infrastructure, population access, environmental risk, construction accessibility — then the recommendation lands on the map with **preliminary cost** (a range, rounded to $1,000), **daily water output**, **people served** and service radius, **implementation time** in weeks, maintenance burden, and a capped confidence score.

Five tabs back it up: **Overview**, **Why** (per-factor contributions), **Evidence** (retrieved sources), **Alternatives** (runner-up sites), **Validation** (assumptions and missing data).

## How it works

```
search ──► /api/geocode ──► TownRef (Mapbox, Nominatim fallback)
                    │
                    ▼         /api/analyze — SSE stream
   ┌────────────────┼────────────────────────┐
   ▼                ▼                        ▼
Overpass       NASA POWER + Open-Elevation   Exa ──► LLM ──► EvidenceFinding[]
roads·buildings   rainfall·solar·terrain     4 parallel searches: need ·
facilities·water                             hydrogeology · infrastructure ·
points·hazards                               environment
protected areas
   └────────────────┬────────────────────────┘
                    ▼
     150–500 deterministic candidate sites
                    ▼
   Turf features → hard exclusions → weighted score → rank
                    ▼
   population · conceptual layout · cost · water output
                    ▼
             AnalysisRun (cached to disk)
```

### The score

Seven normalised factors (`lib/scoring/score.ts`), weights in `lib/config/coefficients.ts`:

| Factor | Weight | Factor | Weight |
| --- | --- | --- | --- |
| Community need | 25% | Distance from existing service | 10% |
| Population access proxy | 20% | Environmental safety | 10% |
| Groundwater feasibility | 18% | Evidence quality | 5% |
| Road & construction access | 12% | | |

**Hard exclusions** zero a candidate outright: inside a mapped protected area, within the hazard buffer of a mapped waste or industrial site, inside a waterway channel, beyond practical road access, too steep, or redundant against an existing mapped water point.

### Cost and yield are formulas, not guesses

The LLM never produces a total. `lib/cost-model/cost.ts` sums line items from labelled planning coefficients and applies a terrain/access multiplier; every line item renders in the UI with its formula and its source. Output is `pumpRate × effectivePumpingHours × efficiency`, shown with the numbers substituted. Totals are **ranges**, never a falsely precise figure.

### Determinism

Identical inputs always produce an identical `AnalysisRun`. `Math.random()` appears nowhere in the analysis path — only in animation timing. Candidate ids, grid order and tie-breaking are stable, which is what makes cached snapshots legitimate rather than decorative.

### Honesty constraints

- No authoritative global flood-zone, contamination, groundwater or land-ownership dataset is claimed. Flood exposure is a **HAND terrain proxy** from sampled elevation and mapped drainage, and is labelled as such.
- Absence of mapped water points is reported as *"No mapped water points were found in OpenStreetMap. This does not prove that none exist."*
- Population is an estimate shown with its method, confidence and limitations.
- Recommendation confidence is capped — this is a desk study.

## Environment

Every key is optional; the app degrades explicitly rather than failing.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` | **public** | Satellite basemap, globe projection, geocoding. Restrict it by URL. |
| `EXA_API_KEY` | server | Live research over institutional sources. |
| `OPENAI_API_KEY` | server | Turns retrieved sources into typed findings; writes the summary. |
| `OPENAI_MODEL` | server | Defaults to `gpt-4.1-mini`. |
| `MAPBOX_SECRET_TOKEN` | server | Keeps geocoding off the client token. |

Server keys are read only inside `app/api/*/route.ts` and the `lib/` modules they import — never in a client component, so they never reach the browser bundle, and they are never logged.

**Evidence falls back in three labelled rungs:** a live Exa search → a saved snapshot of an earlier live search for that town (`data/evidence/<slug>.json`, written by every live run and by `npm run evidence:refresh`; commit these) → hand-written bundled reference sources. With an Exa key but no OpenAI key, live sources are shown as verbatim excerpts that widen the evidence base without adjusting factor scores. Town-level queries that come back thin are retried once at region/country level.

**Without keys** the deterministic geospatial analysis still runs end to end on bundled reference evidence; without a Mapbox token the map renders an instruction panel instead of crashing and geocoding falls back to Nominatim. Every run is labelled with its provenance — `live`, `cache` (a stored run replayed from its real events), `demo`, or `partial`.

## Data endpoints

| Route | Returns |
| --- | --- |
| `GET /api/brief?slug=<slug>[&download=1]` | Markdown project brief for a stored run (404 if that town has no stored run). |
| `POST /api/brief` `{ run }` | Markdown brief for a run the client already holds — use this for live runs on a read-only host. |
| `GET /api/partners?country=<name>[&live=0]` | Verified water organisations for the country, plus search finds when `EXA_API_KEY` is set. |

Partner discovery is the fifth Exa query of every run (`run.partners`). The verified fallback list (`lib/partners/verified.ts`) has every URL checked by hand; search finds are labelled unreviewed. Sourced simulation rates (growth, household size, breakdown and repair time, walking speed, Sphere flow rates, demand) live in `lib/config/behaviour.ts`, each with its citation.

## Layout

```
app/     page.tsx (SSE client, reveal sequence) · api/{geocode,analyze,cached-run}
components/  map/ (AquaMap) · search/ · analysis/ · recommendation/ · ui/
lib/     types.ts · pipeline.ts · config/coefficients.ts (every coefficient, sourced)
         providers/ (overpass·climate·elevation) · evidence/ (exa·llm·signals)
         geospatial/ · scoring/ · cost-model/ · water-output/ · infrastructure/
```

## Data sources

OpenStreetMap via Overpass (ODbL) · NASA POWER climatology (MERRA-2) · Open-Elevation / OpenTopoData (SRTM) · WorldPop 2020 100 m population (CC BY 4.0; the primary people-within-reach estimate, projected forward with national growth, with mapped buildings as fallback and cross-check) · Esri World Imagery + CARTO labels via MapLibre GL · Nominatim · Exa · OpenAI · World Bank WDI, national censuses, Sphere, WHO and REACH/UPGro studies for simulation rates.

Cost coefficients are order-of-magnitude planning figures from published rural water supply benchmarking, labelled in `lib/config/coefficients.ts`. They are screening inputs, not quotations.
