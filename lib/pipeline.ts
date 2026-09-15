import type {
  AnalysisEvent,
  AnalysisRun,
  Candidate,
  CandidateFeatures,
  DataSourceStatus,
  EvidenceFinding,
  TownRef,
  TrackId,
} from "@/lib/types";
import { SERVICE, WATER, WEIGHTS, WEIGHT_LABELS } from "@/lib/config/coefficients";
import { fetchOsm } from "@/lib/providers/overpass";
import { fetchClimate } from "@/lib/providers/climate";
import { fetchTerrain } from "@/lib/providers/elevation";
import { searchEvidence } from "@/lib/evidence/exa";
import { isLlmConfigured, llmLabel, structureFindings, writeNarrative } from "@/lib/evidence/llm";
import { aggregateSignals, NEUTRAL_SIGNALS } from "@/lib/evidence/signals";
import { demoEvidenceFor } from "@/lib/evidence/demo-evidence";
import { analysisRadiusM, generateCandidateGrid } from "@/lib/geospatial/candidates";
import { buildFeatureContext, computeAllFeatures } from "@/lib/geospatial/features";
import { estimatePopulationServed } from "@/lib/geospatial/population";
import { buildConceptualLayout } from "@/lib/geospatial/layout";
import { rankCandidates, scoreCandidate } from "@/lib/scoring/score";
import { buildRecommendation } from "@/lib/infrastructure/select";

export type Emit = (track: TrackId, message: string, status: AnalysisEvent["status"], sourceCount?: number) => void;

const UA = "Mayim/1.0 (hackathon pre-feasibility demo)";

/** Planning figure: one community tap stand per this many people served. */
const PEOPLE_PER_TAP = 250;

/** Fill in a population figure from OSM when the geocoder did not supply one. */
async function enrichPopulation(town: TownRef): Promise<TownRef> {
  if (town.populationHint) return town;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const q = [town.name, town.country].filter(Boolean).join(", ");
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&extratags=1`,
      { signal: ctrl.signal, headers: { "User-Agent": UA } },
    );
    clearTimeout(t);
    if (!res.ok) return town;
    const [hit] = (await res.json()) as { extratags?: { population?: string; "population:date"?: string } }[];
    const pop = hit?.extratags?.population ? Number(hit.extratags.population) : NaN;
    if (!Number.isFinite(pop) || pop <= 0) return town;
    return {
      ...town,
      populationHint: pop,
      populationHintYear: hit?.extratags?.["population:date"],
      populationHintSource: "OpenStreetMap",
    };
  } catch {
    return town;
  }
}

/**
 * Size the storage tank and solar array from demand and hydraulics, so the cost
 * model receives derived inputs rather than magic constants.
 *
 *   tank   = one day of demand at the WHO basic-service figure, clamped to stock sizes
 *   array  = hydraulic power (rho*g*Q*H) / pump-and-controller efficiency, oversized 1.3x
 */
function sizeSystem(peopleServed: number, liftM: number) {
  const dailyDemandL = Math.max(1, peopleServed) * WATER.litersPerPersonPerDay.value;
  const tankVolumeLiters = Math.min(40000, Math.max(5000, Math.round(dailyDemandL / 1000) * 1000));
  const qM3s = WATER.pumpRateLitersPerHour.high / 3600 / 1000;
  const hydraulicW = 1000 * 9.81 * qM3s * liftM;
  const solarArrayWp = Math.round((hydraulicW / 0.45) * 1.3);
  return { tankVolumeLiters, solarArrayWp, dailyDemandL };
}

export async function runAnalysis(inputTown: TownRef, emit: Emit): Promise<AnalysisRun> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const dataSources: DataSourceStatus[] = [];

  emit("water_access", `Resolving ${inputTown.name}`, "active");
  const town = await enrichPopulation(inputTown);
  const radiusM = analysisRadiusM(town);
  emit(
    "water_access",
    town.populationHint
      ? `Population ${town.populationHint.toLocaleString()}`
      : "No population on record — density proxy",
    "active",
  );

  // --- Geospatial and research fan out together; neither blocks the other. ---
  emit("existing_infrastructure", "Loading OSM features", "active");
  emit("environmental_risk", "Requesting terrain and climate", "active");
  emit("hydrogeology", "Searching groundwater sources", "active");

  const [osm, climate, terrain, rawEvidence] = await Promise.all([
    fetchOsm(town),
    fetchClimate(town.center),
    fetchTerrain(town.bbox),
    searchEvidence(town),
  ]);

  dataSources.push({
    name: "OpenStreetMap (Overpass)",
    ok: !osm.degraded,
    detail: osm.degraded
      ? (osm.note ?? "Unavailable")
      : `${osm.roads.length} roads, ${osm.buildings.length} buildings, ${osm.schools.length + osm.clinics.length} facilities, ${osm.waterPoints.length} water points`,
  });
  dataSources.push({
    name: "NASA POWER climatology",
    ok: !climate.estimated,
    detail: climate.estimated ? climate.source : `${Math.round(climate.annualRainfallMm)} mm/yr, ${climate.solarKwhM2Day.toFixed(1)} kWh/m²/day`,
  });
  dataSources.push({
    name: "Elevation sampling",
    ok: !terrain.estimated && terrain.samples.length > 0,
    detail: terrain.samples.length ? `${terrain.samples.length} samples, ${terrain.minM}–${terrain.maxM} m` : "Unavailable",
  });

  if (osm.degraded) {
    warnings.push("OpenStreetMap unavailable — mapped constraints not applied. Exclusions are incomplete.");
    emit("existing_infrastructure", osm.note ?? "OpenStreetMap unavailable", "degraded");
  } else {
    emit("existing_infrastructure", `${osm.roads.length} roads, ${osm.buildings.length} buildings`, "complete", osm.roads.length + osm.buildings.length);
    emit("population_access", `${osm.schools.length} schools, ${osm.clinics.length} clinics`, "active", osm.schools.length + osm.clinics.length);
    if (osm.waterPoints.length === 0) {
      warnings.push("No mapped water points in OSM. This does not prove none exist.");
      emit("existing_infrastructure", "No mapped water points", "degraded");
    } else {
      emit("existing_infrastructure", `${osm.waterPoints.length} mapped water points`, "complete", osm.waterPoints.length);
    }
  }

  if (climate.estimated) warnings.push("Live climate unavailable — fallback rainfall and solar assumptions used.");
  emit(
    "environmental_risk",
    `${Math.round(climate.annualRainfallMm)} mm/yr · ${climate.drySeasonMonths} dry months · ${climate.solarKwhM2Day.toFixed(1)} kWh/m²/day`,
    climate.estimated ? "degraded" : "complete",
  );

  // --- Evidence -------------------------------------------------------------
  let findings: EvidenceFinding[] = [];
  let evidenceProvenance = "";
  if (rawEvidence.length > 0) {
    emit("hydrogeology", `${rawEvidence.length} sources retrieved`, "active", rawEvidence.length);
    if (isLlmConfigured()) {
      emit("water_access", "Extracting findings", "active");
      findings = (await structureFindings(town, rawEvidence)) ?? [];
    }
    if (findings.length === 0) {
      warnings.push("Sources could not be structured — bundled reference evidence used.");
      findings = demoEvidenceFor(town.slug);
      evidenceProvenance = "bundled";
    } else {
      evidenceProvenance = "live";
    }
  } else {
    findings = demoEvidenceFor(town.slug);
    evidenceProvenance = "bundled";
    warnings.push("No live research (EXA_API_KEY missing or unreachable) — bundled sources used.");
  }

  dataSources.push({
    name: "Exa research",
    ok: evidenceProvenance === "live",
    detail: evidenceProvenance === "live" ? `${findings.length} findings from ${rawEvidence.length} sources` : "Not configured — bundled evidence",
  });
  dataSources.push({
    name: llmLabel().startsWith("OpenAI") ? llmLabel() : "LLM structured extraction",
    ok: evidenceProvenance === "live" && isLlmConfigured(),
    detail: isLlmConfigured() ? (evidenceProvenance === "live" ? "Findings classified" : "Configured, no live sources") : "Not configured — deterministic only",
  });

  const signals = findings.length ? aggregateSignals(findings) : NEUTRAL_SIGNALS;
  emit("hydrogeology", `Groundwater confidence ${(signals.groundwater * 100).toFixed(0)}%`, "complete", findings.length);
  emit("water_access", `${findings.length} findings · quality ${(signals.quality * 100).toFixed(0)}%`, "complete", findings.length);

  // --- Candidates -----------------------------------------------------------
  const grid = generateCandidateGrid(town);
  emit("construction_access", `${grid.length} sites · ${(radiusM / 1000).toFixed(1)} km radius`, "active", grid.length);

  const ctx = buildFeatureContext(osm, terrain, signals);
  const { features, maxNearbyBuildings, maxNearbyFacilities } = computeAllFeatures(grid, ctx);
  emit("construction_access", `Scoring ${grid.length} sites`, "active", grid.length);

  const candidates: Candidate[] = grid.map((p) => {
    const f = features.get(p.id) as CandidateFeatures;
    const score = scoreCandidate(f, { signals, maxNearbyBuildings, maxNearbyFacilities });
    return { id: p.id, lon: p.lon, lat: p.lat, features: f, score, excluded: score.exclusions.length > 0 };
  });

  const excludedCount = candidates.filter((c) => c.excluded).length;
  const reasonCounts = new Map<string, number>();
  for (const c of candidates) for (const r of c.score.exclusions) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  emit(
    "environmental_risk",
    excludedCount > 0
      ? `Excluded ${excludedCount}/${candidates.length}${topReason ? ` — ${topReason[0].toLowerCase()}` : ""}`
      : `No exclusions across ${candidates.length} sites`,
    "complete",
    excludedCount,
  );

  const ranked = rankCandidates(candidates);
  const winnerId = ranked[0] ?? null;
  const winner = winnerId ? candidates.find((c) => c.id === winnerId) ?? null : null;

  if (!winner) {
    warnings.push("Every site was excluded by a hard constraint. No recommendation produced.");
  }
  emit("construction_access", winner ? `${ranked.length} viable · best ${winner.score.overall.toFixed(3)}` : "No viable sites", winner ? "complete" : "degraded", ranked.length);

  // --- Population, layout, recommendation ----------------------------------
  const serviceRadiusM = SERVICE.walkingRadiusM;
  const population = estimatePopulationServed({
    town,
    osm,
    winnerFeatures: winner?.features ?? ({} as CandidateFeatures),
    totalBuildingsInArea: osm.buildings.length,
    serviceRadiusM,
  });
  emit("population_access", `${population.rangeLow.toLocaleString()}–${population.rangeHigh.toLocaleString()} people within ${serviceRadiusM} m`, "complete", osm.buildings.length);

  let recommendation = null;
  let layout: AnalysisRun["layout"] = null;
  let layoutPipelineM = 0;
  let layoutTaps = 0;

  if (winner) {
    const hasNearby = (winner.features.distanceToMappedWaterPointM ?? Infinity) < 600;
    const draft = buildConceptualLayout({
      site: { lon: winner.lon, lat: winner.lat },
      features: winner.features,
      osm,
      type: "solar_borehole",
      serviceRadiusM,
    });
    layoutPipelineM = draft.pipelineLengthM;
    layoutTaps = draft.tapStandCount;

    recommendation = buildRecommendation({
      features: winner.features,
      climate,
      population,
      hasNearbyMappedWaterPoint: hasNearby,
      pipelineLengthM: layoutPipelineM,
      tapStandCount: layoutTaps,
    });
    // Rebuild against the selected intervention so the schematic matches it,
    // and size the tap network to the population the system can actually
    // supply (one stand per PEOPLE_PER_TAP) rather than to the radius.
    const servedForTaps = Math.max(1, recommendation.peopleServedHigh);
    layout = buildConceptualLayout({
      site: { lon: winner.lon, lat: winner.lat },
      features: winner.features,
      osm,
      type: recommendation.type,
      serviceRadiusM,
      maxTaps: Math.ceil(servedForTaps / PEOPLE_PER_TAP),
    });

    // Re-cost against the schematic that was actually drawn.
    recommendation = buildRecommendation({
      features: winner.features,
      climate,
      population,
      hasNearbyMappedWaterPoint: hasNearby,
      pipelineLengthM: layout.pipelineLengthM,
      tapStandCount: layout.tapStandCount,
    });
    emit("hydrogeology", `Selected: ${recommendation.label}`, "complete");
  }

  // --- Explanation ----------------------------------------------------------
  const whyThisSite: AnalysisRun["whyThisSite"] = [];
  if (winner) {
    const f = winner.features;
    const b = winner.score.breakdown;
    const ordered = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[])
      .map((k) => ({ k, contribution: b[k] * WEIGHTS[k] }))
      .sort((x, y) => y.contribution - x.contribution);

    for (const { k, contribution } of ordered.slice(0, 4)) {
      whyThisSite.push({
        claim: `${WEIGHT_LABELS[k]} scored ${(b[k] * 100).toFixed(0)}%`,
        basis: `${(contribution * 100).toFixed(1)} of ${(winner.score.overall * 100).toFixed(1)} pts · ${(WEIGHTS[k] * 100).toFixed(0)}% weight`,
        kind: "map",
      });
    }
    whyThisSite.push({
      claim: `${Math.round(f.distanceToRoadM)} m from the nearest mapped road`,
      basis: "OSM road geometry — shorter haul lowers construction cost.",
      kind: "map",
    });
    whyThisSite.push({
      claim: `${f.nearbyBuildingCount} buildings within ${SERVICE.densityRadiusM} m`,
      basis: "OSM building centroids — population access proxy.",
      kind: "map",
    });
    if (f.distanceToMappedWaterPointM !== undefined) {
      whyThisSite.push({
        claim: `Nearest mapped water point is ${Math.round(f.distanceToMappedWaterPointM)} m away`,
        basis: `Sites within ${SERVICE.redundancyRadiusM} m of mapped supply are excluded.`,
        kind: "map",
      });
    } else {
      whyThisSite.push({
        claim: "No mapped water point nearby",
        basis: "Not in OSM. Scored conservatively — absence of mapping is not proof of absence.",
        kind: "assumption",
      });
    }
    for (const fd of findings.filter((x) => x.scoreImpact).slice(0, 3)) {
      whyThisSite.push({
        claim: fd.title,
        basis: `${fd.sourceName} — ${fd.scoreImpact?.factor} ${fd.scoreImpact?.direction} ${(fd.scoreImpact?.magnitude ?? 0).toFixed(2)} · ${(fd.confidence * 100).toFixed(0)}% conf.`,
        kind: "evidence",
        evidenceId: fd.id,
      });
    }
    whyThisSite.push({
      claim: `Flood exposure proxy ${(f.floodProxy * 100).toFixed(0)}%`,
      basis: "Height above nearest drainage. Terrain proxy, not a flood-zone dataset.",
      kind: "assumption",
    });
  }

  const alternatives: AnalysisRun["alternatives"] = [];
  if (winner) {
    for (const id of ranked.slice(1, 3)) {
      const alt = candidates.find((c) => c.id === id);
      if (!alt) continue;
      const diffs = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[])
        .map((k) => ({ k, d: alt.score.breakdown[k] - winner.score.breakdown[k] }))
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      const better = diffs.find((d) => d.d > 0.02);
      const worse = diffs.find((d) => d.d < -0.02);
      const parts: string[] = [];
      if (better) parts.push(`+${(better.d * 100).toFixed(0)} ${WEIGHT_LABELS[better.k].toLowerCase()}`);
      if (worse) parts.push(`${(worse.d * 100).toFixed(0)} ${WEIGHT_LABELS[worse.k].toLowerCase()}`);
      alternatives.push({
        candidateId: id,
        comparison: parts.length
          ? `${parts.join(", ")} · ${((winner.score.overall - alt.score.overall) * 100).toFixed(1)} pts behind.`
          : `Within ${((winner.score.overall - alt.score.overall) * 100).toFixed(1)} pts — no decisive factor.`,
      });
    }
  }

  // --- Narrative ------------------------------------------------------------
  let narrative = "";
  let narrativeSource: AnalysisRun["narrativeSource"] = "deterministic";
  if (winner && recommendation) {
    if (isLlmConfigured()) {
      const written = await writeNarrative({
        town,
        recommendation,
        topScore: winner.score.overall,
        findings,
        population: population.peopleServed,
      });
      if (written) {
        narrative = written;
        narrativeSource = "llm";
      }
    }
    if (!narrative) {
      narrative =
        `${ranked.length} of ${candidates.length} sites near ${town.name} passed all hard constraints; the best scores ${(winner.score.overall * 100).toFixed(0)}% ` +
        `(${Math.round(winner.features.distanceToRoadM)} m from a road, ${winner.features.nearbyBuildingCount} buildings within ${SERVICE.densityRadiusM} m). ` +
        `A ${recommendation.label.toLowerCase()} at $${recommendation.cost.totalLow.toLocaleString()}–$${recommendation.cost.totalHigh.toLocaleString()} would serve ${population.rangeLow.toLocaleString()}–${population.rangeHigh.toLocaleString()} people. ` +
        `Pre-feasibility only — field validation required.`;
    }
  } else {
    narrative = `No viable site found near ${town.name} within the mapped constraints.`;
  }

  const events: AnalysisEvent[] = [];
  return {
    version: 1,
    town,
    createdAt: startedAt,
    provenance: "live",
    events,
    osm,
    climate,
    terrain,
    findings,
    signals,
    candidates,
    candidateCount: candidates.length,
    excludedCount,
    ranked,
    winnerId,
    population,
    recommendation,
    layout,
    narrative,
    narrativeSource,
    whyThisSite,
    alternatives,
    dataSources,
    warnings,
  };
}

export { sizeSystem };
