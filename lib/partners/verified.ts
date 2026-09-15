/**
 * Curated partner organisations — the fallback when live search is off.
 *
 * Every URL was fetched on LAST_VERIFIED and returned 200, except sites behind
 * bot protection (wateraid.org, unicef.org, ircwash.org, water.org,
 * thewaterproject.org, africanwaterfacility.org), which answer 403 to scripts
 * and were confirmed via search instead. An organisation is listed for a
 * country only where its current work there could be confirmed; descriptions
 * are neutral and carry no statistics.
 *
 * Deliberately absent: WaterAid Kenya (no current country programme found),
 * Water.org and Water Mission in Ghana (no confirmed presence). Ghana Water
 * Limited's own domain was suspended at verification time, so it links to its
 * Ghana.GOV listing.
 */

import type { Partner } from "@/lib/types";

const LAST_VERIFIED = "2026-09-15";

type Entry = Omit<Partner, "id" | "source" | "lastVerified" | "countryUrl"> & { countryUrl?: string };

const ENTRIES: Entry[] = [
  // --- Global / regional -----------------------------------------------------
  {
    name: "WaterAid",
    kind: "ngo",
    country: "global",
    url: "https://www.wateraid.org/",
    description: "International NGO working across sub-Saharan Africa on water supply, sanitation and hygiene services and on WASH sector policy and advocacy.",
    focus: ["piped_schemes", "sanitation", "policy", "water_quality"],
  },
  {
    name: "charity: water",
    kind: "funder",
    country: "global",
    url: "https://www.charitywater.org/",
    description: "Funds construction and rehabilitation of boreholes, wells and piped systems delivered by local implementing partners across sub-Saharan Africa.",
    focus: ["boreholes", "handpumps", "rainwater", "piped_schemes", "funding"],
  },
  {
    name: "UNICEF WASH",
    kind: "multilateral",
    country: "global",
    url: "https://www.unicef.org/water-sanitation-and-hygiene-wash",
    description: "Supports government WASH systems, emergency water response, and water-quality and sanitation programming across sub-Saharan Africa.",
    focus: ["emergency", "sanitation", "policy", "water_quality"],
  },
  {
    name: "World Vision WASH",
    kind: "ngo",
    country: "global",
    url: "https://www.wvi.org/our-work/cleanwater",
    description: "Implements borehole drilling, solar-powered piped systems, sanitation and emergency WASH response in many sub-Saharan African countries.",
    focus: ["boreholes", "solar_pumping", "sanitation", "emergency"],
  },
  {
    name: "IRC WASH",
    kind: "ngo",
    country: "global",
    url: "https://www.ircwash.org/",
    description: "Works with governments and utilities to strengthen WASH systems, financing and service monitoring, including life-cycle costing of rural water.",
    focus: ["policy", "maintenance", "funding"],
  },
  {
    name: "Rural Water Supply Network (RWSN)",
    kind: "network",
    country: "global",
    url: "https://www.rural-water-supply.net/en/",
    description: "Global network of rural water professionals publishing handpump, borehole-siting and rural water supply technical guidance.",
    focus: ["handpumps", "boreholes", "maintenance", "policy"],
  },
  {
    name: "African Water Facility (AfDB)",
    kind: "multilateral",
    country: "global",
    url: "https://www.africanwaterfacility.org/en",
    description: "African Development Bank-hosted facility providing grants and project-preparation support for water and sanitation projects across Africa.",
    focus: ["funding", "piped_schemes", "policy"],
  },

  // --- Kenya -----------------------------------------------------------------
  {
    name: "Kisumu Water and Sanitation Company (KIWASCO)",
    kind: "utility",
    country: "KE",
    url: "https://kiwasco.co.ke/",
    description: "Licensed utility supplying piped water and sewerage services within Kisumu City and County.",
    focus: ["piped_schemes", "sanitation", "water_quality"],
  },
  {
    name: "Water Sector Trust Fund",
    kind: "government",
    country: "KE",
    url: "https://waterfund.go.ke/",
    description: "State corporation that grants funds to counties and community projects for water and sanitation infrastructure in underserved areas.",
    focus: ["funding", "boreholes", "piped_schemes"],
  },
  {
    name: "KEWASNET",
    kind: "network",
    country: "KE",
    url: "https://kewasnet.co.ke/",
    description: "Kenya Water and Sanitation Civil Society Network — coordinates member organisations and advocates on WASH governance and policy.",
    focus: ["policy", "sanitation"],
  },
  {
    name: "FundiFix",
    kind: "ngo",
    country: "KE",
    url: "https://fundifix.org/",
    description: "Social enterprise from Oxford/REACH research offering maintenance contracts that keep rural handpumps and boreholes working in Kitui and Kwale.",
    focus: ["maintenance", "handpumps", "boreholes"],
  },
  {
    name: "Evidence Action — Dispensers for Safe Water",
    kind: "ngo",
    country: "KE",
    url: "https://www.evidenceaction.org/programs/safe-water-now",
    countryUrl: "https://www.evidenceaction.org/where-we-work/kenya",
    description: "Installs and maintains free chlorine dispensers at rural water points in Kenya to disinfect water at the source.",
    focus: ["water_quality", "maintenance"],
  },
  {
    name: "The Water Project",
    kind: "ngo",
    country: "KE",
    url: "https://thewaterproject.org/",
    countryUrl: "https://thewaterproject.org/community/projects/kenya/",
    description: "Funds and monitors well rehabilitation, new boreholes, sand dams and rainwater catchment in western and south-eastern Kenya.",
    focus: ["boreholes", "rainwater", "water_quality"],
  },
  {
    name: "Water.org",
    kind: "funder",
    country: "KE",
    url: "https://water.org/",
    countryUrl: "https://water.org/our-impact/where-we-work/kenya/",
    description: "Partners with Kenyan lenders to offer small loans that let households finance water connections, storage tanks and toilets.",
    focus: ["funding", "sanitation"],
  },
  {
    name: "Water Mission",
    kind: "ngo",
    country: "KE",
    url: "https://watermission.org/",
    countryUrl: "https://watermission.org/about/offices/kenya",
    description: "Engineering NGO with an office in Kitale that builds solar-powered piped water systems and responds to water emergencies in Kenya.",
    focus: ["solar_pumping", "piped_schemes", "emergency"],
  },

  // --- Uganda ----------------------------------------------------------------
  {
    name: "Ministry of Water and Environment",
    kind: "government",
    country: "UG",
    url: "https://www.mwe.go.ug/",
    description: "Government ministry responsible for national water policy, standards, sector performance reporting and rural water investment.",
    focus: ["policy", "funding"],
  },
  {
    name: "National Water and Sewerage Corporation (NWSC)",
    kind: "utility",
    country: "UG",
    url: "https://www.nwsc.co.ug/",
    description: "State-owned utility operating piped water and sewerage in Ugandan towns, including a service area in Gulu City.",
    focus: ["piped_schemes", "water_quality", "maintenance"],
  },
  {
    name: "WaterAid Uganda",
    kind: "ngo",
    country: "UG",
    url: "https://www.wateraid.org/",
    countryUrl: "https://www.wateraid.org/ug",
    description: "WaterAid's Uganda programme, working with government and communities on water supply, sanitation and hygiene services.",
    focus: ["piped_schemes", "sanitation", "policy"],
  },
  {
    name: "Water For People Uganda",
    kind: "ngo",
    country: "UG",
    url: "https://www.waterforpeople.org/uganda/",
    description: "Supports piped water systems and a private-sector service model in Kamwenge and Luuka districts, plus sanitation programmes.",
    focus: ["piped_schemes", "sanitation", "maintenance"],
  },
  {
    name: "Whave Solutions",
    kind: "ngo",
    country: "UG",
    url: "https://www.whave.org/",
    description: "Signs preventive-maintenance agreements with communities and district governments to keep handpumps and piped systems running.",
    focus: ["maintenance", "handpumps", "piped_schemes"],
  },
  {
    name: "UWASNET",
    kind: "network",
    country: "UG",
    url: "https://uwasnet.org/",
    description: "Uganda Water and Sanitation NGO Network — umbrella body linking civil-society WASH organisations with central and local government.",
    focus: ["policy"],
  },
  {
    name: "Evidence Action — Dispensers for Safe Water",
    kind: "ngo",
    country: "UG",
    url: "https://www.evidenceaction.org/programs/safe-water-now",
    countryUrl: "https://www.evidenceaction.org/where-we-work/uganda",
    description: "Installs and maintains free chlorine dispensers at rural water points in Uganda to disinfect water at the source.",
    focus: ["water_quality", "maintenance"],
  },
  {
    name: "Water Mission Uganda",
    kind: "ngo",
    country: "UG",
    url: "https://watermission.org/",
    countryUrl: "https://watermission.org/about/offices/uganda",
    description: "Engineering NGO building solar-powered piped water systems in Uganda, including in refugee-hosting areas.",
    focus: ["solar_pumping", "piped_schemes", "emergency"],
  },
  {
    name: "Water.org",
    kind: "funder",
    country: "UG",
    url: "https://water.org/",
    countryUrl: "https://water.org/our-impact/where-we-work/uganda/",
    description: "Partners with Ugandan lenders to offer small loans for household water and sanitation improvements.",
    focus: ["funding", "sanitation"],
  },

  // --- Ghana -----------------------------------------------------------------
  {
    name: "Community Water and Sanitation Agency (CWSA)",
    kind: "government",
    country: "GH",
    url: "https://www.cwsa.gov.gh/",
    description: "Government agency mandated to facilitate safe water and sanitation services for rural communities and small towns.",
    focus: ["boreholes", "handpumps", "piped_schemes", "policy"],
  },
  {
    name: "Ghana Water Limited",
    kind: "utility",
    country: "GH",
    url: "https://www.ghana.gov.gh/mdas/0e24e70b96/",
    description: "State-owned utility responsible for producing and distributing piped water in Ghana's urban areas, including Tamale.",
    focus: ["piped_schemes", "water_quality"],
  },
  {
    name: "Saha Global",
    kind: "ngo",
    country: "GH",
    url: "https://sahaglobal.org/",
    description: "Works in Northern Ghana, including around Tamale, training local women to run community water-treatment businesses.",
    focus: ["water_quality", "maintenance"],
  },
  {
    name: "WaterAid Ghana",
    kind: "ngo",
    country: "GH",
    url: "https://www.wateraid.org/",
    countryUrl: "https://www.wateraid.org/gh",
    description: "WaterAid's Ghana programme, focused on WASH services in the Upper West and Upper East regions and national policy.",
    focus: ["piped_schemes", "sanitation", "policy"],
  },
  {
    name: "World Vision Ghana",
    kind: "ngo",
    country: "GH",
    url: "https://www.wvi.org/",
    countryUrl: "https://www.wvi.org/ghana",
    description: "Drills and mechanises boreholes, including solar-powered systems, for rural communities and schools in Ghana.",
    focus: ["boreholes", "solar_pumping", "sanitation"],
  },
  {
    name: "Safe Water Network Ghana",
    kind: "ngo",
    country: "GH",
    url: "https://safewaternetwork.org/our-work/ghana/",
    description: "Develops locally run small water enterprises serving rural, small-town and peri-urban communities in Ghana.",
    focus: ["piped_schemes", "water_quality", "maintenance"],
  },
  {
    name: "CONIWAS",
    kind: "network",
    country: "GH",
    url: "https://coniwasghana.com/",
    description: "Coalition of NGOs in Water and Sanitation — advocates on WASH policy and coordinates civil society with government agencies.",
    focus: ["policy"],
  },
];

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export const VERIFIED_PARTNERS: readonly Partner[] = ENTRIES.map((e) => ({
  ...e,
  id: `verified-${e.country.toLowerCase()}-${slug(e.name)}`,
  source: "verified" as const,
  lastVerified: LAST_VERIFIED,
}));

/** Country organisations first, then multi-country ones. Unknown country → global list only. */
export function verifiedPartnersFor(iso2: string | undefined): Partner[] {
  const code = iso2?.toUpperCase();
  const local = code ? VERIFIED_PARTNERS.filter((p) => p.country === code) : [];
  const global = VERIFIED_PARTNERS.filter((p) => p.country === "global");
  return [...local, ...global].map((p) => ({ ...p, focus: [...p.focus] }));
}
