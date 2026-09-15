/**
 * Bundled demo evidence.
 *
 * These stand in for a previously saved research run so the app is fully
 * demonstrable with no API keys configured. They are deliberately conservative
 * and honest:
 *   - every sourceUrl is a stable, well-known institutional landing page, not a
 *     deep link to a specific PDF or report id;
 *   - every summary describes the organisation's work and the regional context
 *     in general terms — no statistic is attributed to any specific report;
 *   - every summary is prefixed so the UI cannot present these as live results;
 *   - confidences sit in the 0.45-0.70 band and score impacts are modest.
 */

import type { EvidenceFinding } from "@/lib/types";

const TAG = "Bundled demo source (no live search was run) —";

const URLS = {
  jmp: "https://washdata.org",
  whoWash: "https://www.who.int/health-topics/water-sanitation-and-hygiene-wash",
  unicefWash: "https://www.unicef.org/wash",
  bgsAtlas: "https://www.bgs.ac.uk/geology-projects/africa-groundwater-atlas/",
  worldBankWater: "https://www.worldbank.org/en/topic/water",
  aquastat: "https://www.fao.org/aquastat/en/",
  wateraid: "https://www.wateraid.org",
  ircwash: "https://www.ircwash.org",
  reliefweb: "https://reliefweb.int",
} as const;

const KISUMU: EvidenceFinding[] = [
  {
    id: "demo-kisumu-1",
    category: "water_need",
    title: "WHO/UNICEF Joint Monitoring Programme — drinking water service levels",
    summary: `${TAG} The JMP maintains the official national and sub-national ladder for drinking-water service levels in Kenya, distinguishing safely managed, basic, limited, unimproved and surface-water use. Peri-urban settlements around Lake Victoria are the kind of setting where the JMP ladder typically separates piped-network households from neighbours still relying on limited or surface sources.`,
    sourceName: "WHO/UNICEF Joint Monitoring Programme",
    sourceUrl: URLS.jmp,
    confidence: 0.65,
    scoreImpact: { factor: "need", direction: "increase", magnitude: 0.22 },
  },
  {
    id: "demo-kisumu-2",
    category: "hydrogeology",
    title: "BGS Africa Groundwater Atlas — Kenya hydrogeology",
    summary: `${TAG} The British Geological Survey's Africa Groundwater Atlas describes Kenya's aquifer environments, including the weathered and fractured basement and the sedimentary and volcanic units of the Lake Victoria basin. Basement and weathered-zone aquifers of this kind generally support community-scale boreholes but with yields that vary sharply over short distances.`,
    sourceName: "British Geological Survey",
    sourceUrl: URLS.bgsAtlas,
    confidence: 0.6,
    scoreImpact: { factor: "groundwater", direction: "increase", magnitude: 0.15 },
  },
  {
    id: "demo-kisumu-3",
    category: "environment",
    title: "WHO — water, sanitation and hygiene topic guidance",
    summary: `${TAG} WHO's WASH guidance covers drinking-water quality, sanitary protection of sources and the health burden of contaminated supplies. Densely settled lakeside and peri-urban areas with shallow water tables and on-site sanitation are the classic setting for the source-contamination pathways this guidance addresses.`,
    sourceName: "World Health Organization",
    sourceUrl: URLS.whoWash,
    confidence: 0.55,
    scoreImpact: { factor: "risk", direction: "increase", magnitude: 0.18 },
  },
  {
    id: "demo-kisumu-4",
    category: "water_need",
    title: "UNICEF — WASH programming",
    summary: `${TAG} UNICEF runs long-standing WASH programmes across Kenya covering water supply for schools, health facilities and underserved communities. Its programme framing consistently identifies rapidly growing peri-urban fringes as areas where service expansion lags settlement growth.`,
    sourceName: "UNICEF",
    sourceUrl: URLS.unicefWash,
    confidence: 0.6,
    scoreImpact: { factor: "need", direction: "increase", magnitude: 0.16 },
  },
  {
    id: "demo-kisumu-5",
    category: "infrastructure",
    title: "World Bank — Water global practice",
    summary: `${TAG} The World Bank's water portfolio includes urban and rural water-supply investment and utility-strengthening operations in Kenya. Kisumu is a regional urban centre with an established utility and trunk road network, which generally lowers mobilisation difficulty for construction compared with remote rural sites.`,
    sourceName: "World Bank",
    sourceUrl: URLS.worldBankWater,
    confidence: 0.5,
    scoreImpact: { factor: "access", direction: "decrease", magnitude: 0.14 },
  },
  {
    id: "demo-kisumu-6",
    category: "environment",
    title: "FAO AQUASTAT — water resources information",
    summary: `${TAG} AQUASTAT compiles national water-resource and withdrawal statistics, including renewable resources and seasonality. Kenya's bimodal rainfall regime means supply schemes must be sized for inter-seasonal variability rather than for annual averages alone.`,
    sourceName: "Food and Agriculture Organization of the United Nations",
    sourceUrl: URLS.aquastat,
    confidence: 0.45,
    scoreImpact: { factor: "risk", direction: "increase", magnitude: 0.1 },
  },
];

const GULU: EvidenceFinding[] = [
  {
    id: "demo-gulu-1",
    category: "water_need",
    title: "WHO/UNICEF Joint Monitoring Programme — drinking water service levels",
    summary: `${TAG} The JMP publishes Uganda's drinking-water service-level breakdown and the rural-urban split behind it. Northern Uganda is a region where the gap between improved-source availability and a genuinely basic service (round trip under thirty minutes) is a standard planning concern.`,
    sourceName: "WHO/UNICEF Joint Monitoring Programme",
    sourceUrl: URLS.jmp,
    confidence: 0.65,
    scoreImpact: { factor: "need", direction: "increase", magnitude: 0.24 },
  },
  {
    id: "demo-gulu-2",
    category: "hydrogeology",
    title: "BGS Africa Groundwater Atlas — Uganda hydrogeology",
    summary: `${TAG} The BGS Africa Groundwater Atlas describes Uganda as dominated by weathered and fractured Precambrian basement, where groundwater is typically found in the weathered regolith and in fracture zones. Aquifers of this type generally sustain handpump and small motorised borehole abstraction, with success depending heavily on siting within the weathered profile.`,
    sourceName: "British Geological Survey",
    sourceUrl: URLS.bgsAtlas,
    confidence: 0.6,
    scoreImpact: { factor: "groundwater", direction: "increase", magnitude: 0.18 },
  },
  {
    id: "demo-gulu-3",
    category: "water_need",
    title: "ReliefWeb — humanitarian situation reporting for Uganda",
    summary: `${TAG} ReliefWeb aggregates humanitarian reporting from UN agencies and NGOs operating in Uganda, including WASH cluster updates. Northern Uganda hosts significant displaced and refugee populations, which places additional and often sudden demand on existing community water points.`,
    sourceName: "ReliefWeb (UN OCHA)",
    sourceUrl: URLS.reliefweb,
    confidence: 0.5,
    scoreImpact: { factor: "need", direction: "increase", magnitude: 0.14 },
  },
  {
    id: "demo-gulu-4",
    category: "infrastructure",
    title: "WaterAid — Uganda country programme",
    summary: `${TAG} WaterAid runs a country programme in Uganda covering rural and small-town water supply, sanitation and hygiene. An established implementing presence and functioning district-level supply chains generally reduce the practical difficulty of delivering and maintaining new water points.`,
    sourceName: "WaterAid",
    sourceUrl: URLS.wateraid,
    confidence: 0.55,
    scoreImpact: { factor: "access", direction: "decrease", magnitude: 0.12 },
  },
  {
    id: "demo-gulu-5",
    category: "environment",
    title: "UNICEF — WASH programming",
    summary: `${TAG} UNICEF's WASH programming addresses water quality and safe-source protection alongside supply expansion. In areas where shallow hand-dug wells and unprotected springs remain in use next to on-site sanitation, sanitary protection of the source is a recurring risk to manage.`,
    sourceName: "UNICEF",
    sourceUrl: URLS.unicefWash,
    confidence: 0.5,
    scoreImpact: { factor: "risk", direction: "increase", magnitude: 0.12 },
  },
  {
    id: "demo-gulu-6",
    category: "infrastructure",
    title: "IRC — rural water service delivery and life-cycle costs",
    summary: `${TAG} IRC works on water-service sustainability and popularised life-cycle cost analysis, which accounts for operation, minor and capital maintenance rather than construction alone. Applied to rural motorised boreholes, that framing consistently shows recurrent costs materially above the initial build.`,
    sourceName: "IRC WASH",
    sourceUrl: URLS.ircwash,
    confidence: 0.5,
    scoreImpact: { factor: "cost", direction: "increase", magnitude: 0.12 },
  },
];

const TAMALE: EvidenceFinding[] = [
  {
    id: "demo-tamale-1",
    category: "water_need",
    title: "WHO/UNICEF Joint Monitoring Programme — drinking water service levels",
    summary: `${TAG} The JMP tracks Ghana's drinking-water service levels and the regional differences within them. Northern Ghana is routinely treated as a distinct planning context from the coastal south, with a larger share of the population dependent on point sources rather than piped supply.`,
    sourceName: "WHO/UNICEF Joint Monitoring Programme",
    sourceUrl: URLS.jmp,
    confidence: 0.6,
    scoreImpact: { factor: "need", direction: "increase", magnitude: 0.2 },
  },
  {
    id: "demo-tamale-2",
    category: "hydrogeology",
    title: "BGS Africa Groundwater Atlas — Ghana hydrogeology",
    summary: `${TAG} The BGS Africa Groundwater Atlas describes northern Ghana as largely underlain by the Voltaian sedimentary basin, where groundwater occurs mainly in fractures rather than in a continuous porous aquifer. Borehole yields in this setting are typically low and highly variable, and drilling failure rates are higher than in weathered-basement terrain.`,
    sourceName: "British Geological Survey",
    sourceUrl: URLS.bgsAtlas,
    confidence: 0.6,
    scoreImpact: { factor: "groundwater", direction: "decrease", magnitude: 0.2 },
  },
  {
    id: "demo-tamale-3",
    category: "water_need",
    title: "WaterAid — Ghana country programme",
    summary: `${TAG} WaterAid runs a country programme in Ghana with a long-standing focus on underserved communities in the northern regions. Its programme framing identifies rural and peri-urban northern communities as priority areas for water-point provision and rehabilitation.`,
    sourceName: "WaterAid",
    sourceUrl: URLS.wateraid,
    confidence: 0.55,
    scoreImpact: { factor: "need", direction: "increase", magnitude: 0.14 },
  },
  {
    id: "demo-tamale-4",
    category: "infrastructure",
    title: "World Bank — Water global practice",
    summary: `${TAG} The World Bank supports water-supply and sanitation investment in Ghana, including small-town and rural service delivery. Tamale is a well-connected regional capital on the national trunk road network, which generally eases equipment mobilisation relative to remote districts.`,
    sourceName: "World Bank",
    sourceUrl: URLS.worldBankWater,
    confidence: 0.5,
    scoreImpact: { factor: "access", direction: "decrease", magnitude: 0.12 },
  },
  {
    id: "demo-tamale-5",
    category: "environment",
    title: "FAO AQUASTAT — water resources information",
    summary: `${TAG} AQUASTAT compiles national water-resource and rainfall-seasonality data. Northern Ghana has a single pronounced wet season followed by a long dry season, so storage sizing and dry-season yield are the binding constraints on any surface- or shallow-source scheme.`,
    sourceName: "Food and Agriculture Organization of the United Nations",
    sourceUrl: URLS.aquastat,
    confidence: 0.55,
    scoreImpact: { factor: "risk", direction: "increase", magnitude: 0.16 },
  },
  {
    id: "demo-tamale-6",
    category: "infrastructure",
    title: "IRC — water services in Ghana and life-cycle costs",
    summary: `${TAG} IRC has a long-running Ghana programme focused on making water services last, using life-cycle cost analysis that counts operation and maintenance alongside construction. That framing consistently shows recurrent costs as the decisive factor in whether a rural water point stays functional.`,
    sourceName: "IRC WASH",
    sourceUrl: URLS.ircwash,
    confidence: 0.5,
    scoreImpact: { factor: "cost", direction: "increase", magnitude: 0.12 },
  },
];

const DEFAULT: EvidenceFinding[] = [
  {
    id: "demo-default-1",
    category: "water_need",
    title: "WHO/UNICEF Joint Monitoring Programme — drinking water service levels",
    summary: `${TAG} The JMP is the official custodian of global drinking-water, sanitation and hygiene monitoring, publishing the service ladder used to distinguish safely managed, basic, limited, unimproved and surface-water use. It is the standard reference for establishing baseline coverage before any siting decision.`,
    sourceName: "WHO/UNICEF Joint Monitoring Programme",
    sourceUrl: URLS.jmp,
    confidence: 0.55,
    scoreImpact: { factor: "need", direction: "increase", magnitude: 0.15 },
  },
  {
    id: "demo-default-2",
    category: "environment",
    title: "WHO — water, sanitation and hygiene topic guidance",
    summary: `${TAG} WHO publishes drinking-water quality guidelines and sanitary-inspection guidance for protecting sources from contamination. Any new water point requires water-quality testing and a sanitary protection radius before it is treated as a safe supply.`,
    sourceName: "World Health Organization",
    sourceUrl: URLS.whoWash,
    confidence: 0.5,
    scoreImpact: { factor: "risk", direction: "increase", magnitude: 0.1 },
  },
  {
    id: "demo-default-3",
    category: "water_need",
    title: "UNICEF — WASH programming",
    summary: `${TAG} UNICEF implements WASH programmes worldwide covering community water supply and services for schools and health facilities. Its programme guidance treats schools and clinics as priority demand points when siting new community water infrastructure.`,
    sourceName: "UNICEF",
    sourceUrl: URLS.unicefWash,
    confidence: 0.5,
    scoreImpact: { factor: "need", direction: "increase", magnitude: 0.12 },
  },
  {
    id: "demo-default-4",
    category: "infrastructure",
    title: "World Bank — Water global practice",
    summary: `${TAG} The World Bank's water practice finances and documents water-supply investment across low- and middle-income countries. Its operational experience consistently stresses that unit costs vary widely with terrain, drilling conditions and mobilisation distance.`,
    sourceName: "World Bank",
    sourceUrl: URLS.worldBankWater,
    confidence: 0.45,
    scoreImpact: { factor: "cost", direction: "increase", magnitude: 0.08 },
  },
];

/** Bundled, clearly-labelled findings so the app is demonstrable with no API keys. Keyed by town slug, plus a "default" key. */
export const DEMO_EVIDENCE: Record<string, EvidenceFinding[]> = {
  "kisumu-kenya": KISUMU,
  "gulu-uganda": GULU,
  "tamale-ghana": TAMALE,
  default: DEFAULT,
};

export function demoEvidenceFor(slug: string): EvidenceFinding[] {
  const key = slug.trim().toLowerCase();
  const matched = Object.prototype.hasOwnProperty.call(DEMO_EVIDENCE, key)
    ? DEMO_EVIDENCE[key]
    : DEMO_EVIDENCE.default;
  // Copy so callers cannot mutate the bundled snapshot.
  return matched.map((finding) => {
    const copy: EvidenceFinding = { ...finding };
    if (finding.scoreImpact) copy.scoreImpact = { ...finding.scoreImpact };
    return copy;
  });
}
