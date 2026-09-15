/**
 * Water Point Data Exchange (WPdx+) — surveyed water points with functional
 * status, shared by governments and NGOs. Socrata open-data API; no key.
 *
 * Two traps in the schema are handled here so callers cannot fall into them:
 *   - `status_id` records whether ANY water flowed on the survey day, not
 *     whether the point works. Functionality comes from `status_clean`.
 *   - `local_population` counts everyone within 1 km of a point, and those
 *     circles overlap between neighbours, so it is never summed.
 *     `_pop_who_would_gain_access` is WPdx's own de-duplicated figure (people
 *     with no other working point nearby) and is safe to sum.
 */

import { fetchJson } from "@/lib/providers/fetchWithTimeout";

const ENDPOINT = "https://data.waterpointdata.org/resource/eqje-vguj.json";
const TIMEOUT_MS = 20_000;

export const WPDX = {
  source: "Water Point Data Exchange (WPdx+), CC BY 4.0",
  url: "https://www.waterpointdata.org/",
  datasetUrl: "https://data.waterpointdata.org/dataset/Water-Point-Data-Exchange-Plus-WPdx-/eqje-vguj",
} as const;

export type WaterPointStatus =
  | "working"
  | "needs_repair"
  | "idle"
  | "broken"
  | "seasonal"
  | "abandoned"
  | "unknown";

/** Maps WPdx `status_clean` categories onto Mayim's status set. */
export function classifyStatus(statusClean: string | null | undefined): WaterPointStatus {
  const s = (statusClean ?? "").trim().toLowerCase();
  if (s.startsWith("abandoned")) return "abandoned";
  if (s.startsWith("non-functional") || s.startsWith("non functional")) {
    return s.includes("dry season") ? "seasonal" : "broken";
  }
  if (s.startsWith("functional")) {
    if (s.includes("needs repair")) return "needs_repair";
    if (s.includes("not in use")) return "idle";
    return "working";
  }
  return "unknown";
}

/** One (district, status, data source) group from the grouped country query. */
export type DistrictStatusRow = {
  region: string;
  district: string;
  /** Organisation that surveyed these points (e.g. "CWSA"). */
  source: string;
  status: WaterPointStatus;
  count: number;
  wouldRegainAccess: number;
  lat: number | null;
  lon: number | null;
  latestReport: string | null;
};

type RawRow = Partial<
  Record<"clean_adm1" | "clean_adm2" | "source" | "status_clean" | "n" | "gain" | "lat" | "lon" | "latest", string>
>;

function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function coord(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Socrata returns every aggregate as a string; rows without a district or count are dropped. */
export function parseDistrictRows(payload: unknown): DistrictStatusRow[] {
  if (!Array.isArray(payload)) return [];
  const out: DistrictStatusRow[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as RawRow;
    const district = r.clean_adm2?.trim();
    const count = num(r.n);
    if (!district || count <= 0) continue;
    out.push({
      region: r.clean_adm1?.trim() ?? "",
      district,
      source: r.source?.trim() || "Unknown source",
      status: classifyStatus(r.status_clean),
      count,
      wouldRegainAccess: Math.max(0, num(r.gain)),
      lat: coord(r.lat),
      lon: coord(r.lon),
      latestReport: r.latest ? r.latest.slice(0, 10) : null,
    });
  }
  return out;
}

/**
 * Latest report per water point, grouped by district and status, for one
 * country. Null when WPdx is unreachable; [] when it has no data for the country.
 */
export async function fetchDistrictStatus(iso3: string): Promise<DistrictStatusRow[] | null> {
  if (!/^[A-Z]{3}$/.test(iso3)) return null;
  const params = new URLSearchParams({
    $select:
      "clean_adm1,clean_adm2,source,status_clean,count(*) as n,sum(_pop_who_would_gain_access) as gain," +
      "avg(lat_deg) as lat,avg(lon_deg) as lon,max(report_date) as latest",
    $where: `clean_country_id='${iso3}' AND is_latest=true`,
    $group: "clean_adm1,clean_adm2,source,status_clean",
    $limit: "50000",
  });
  const payload = await fetchJson<unknown>(
    `${ENDPOINT}?${params.toString()}`,
    { cache: "no-store", headers: { Accept: "application/json" } },
    TIMEOUT_MS,
  );
  return payload === null ? null : parseDistrictRows(payload);
}
