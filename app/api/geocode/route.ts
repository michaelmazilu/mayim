import { NextResponse } from "next/server";
import { townSlug } from "@/lib/cache/cache";
import { fetchJson, fetchWithTimeout } from "@/lib/providers/fetchWithTimeout";
import type { TownRef } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA = "Mayim/1.0 (hackathon pre-feasibility demo)";

function pad(center: [number, number], km: number): [number, number, number, number] {
  const dLat = km / 111;
  const dLon = km / (111 * Math.max(0.2, Math.cos((center[1] * Math.PI) / 180)));
  return [center[0] - dLon, center[1] - dLat, center[0] + dLon, center[1] + dLat];
}

type MapboxCtx = { id: string; name: string };
type MapboxFeature = {
  properties?: {
    name?: string;
    place_formatted?: string;
    full_address?: string;
    bbox?: [number, number, number, number];
    coordinates?: { longitude: number; latitude: number };
    context?: Record<string, MapboxCtx>;
  };
};

async function viaMapbox(q: string, token: string): Promise<TownRef[]> {
  const url =
    `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}` +
    `&types=place,locality,district&limit=5&access_token=${token}`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } }, 6000);
  if (!res.ok) {
    // 401 = bad/revoked token; 403 = token lacks the geocoding scope (or billing is off).
    const hint = res.status === 403 ? " — token is missing the geocoding scope" : "";
    throw new Error(`mapbox ${res.status}${hint}`);
  }
  const data = (await res.json()) as { features?: MapboxFeature[] };
  return (data.features ?? []).flatMap((f): TownRef[] => {
    const p = f.properties;
    const c = p?.coordinates;
    if (!p?.name || !c) return [];
    const center: [number, number] = [c.longitude, c.latitude];
    const country = p.context?.country?.name;
    const region = p.context?.region?.name;
    return [
      {
        slug: townSlug(p.name, country),
        name: p.name,
        region,
        country,
        displayName: p.full_address ?? [p.name, p.place_formatted].filter(Boolean).join(", "),
        center,
        bbox: p.bbox ?? pad(center, 6),
      },
    ];
  });
}

type NominatimItem = {
  name?: string;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
  address?: { country?: string; state?: string; county?: string; region?: string };
  extratags?: { population?: string; "population:date"?: string };
};

async function viaNominatim(q: string): Promise<TownRef[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
    `&format=json&limit=5&extratags=1&addressdetails=1`;
  // fetchJson retries once: dual-stack hosts intermittently ETIMEDOUT on
  // networks with broken IPv6, and a single miss should not empty the search.
  const data = await fetchJson<NominatimItem[]>(url, { headers: { "User-Agent": UA } }, 8000);
  if (!data) throw new Error("nominatim unreachable");
  return data.map((it): TownRef => {
    const center: [number, number] = [Number(it.lon), Number(it.lat)];
    const country = it.address?.country;
    const name = it.name ?? it.display_name.split(",")[0].trim();
    const [s, n, w, e] = it.boundingbox.map(Number);
    const pop = it.extratags?.population ? Number(it.extratags.population) : undefined;
    return {
      slug: townSlug(name, country),
      name,
      region: it.address?.state ?? it.address?.region ?? it.address?.county,
      country,
      displayName: it.display_name,
      center,
      bbox: Number.isFinite(w) ? [w, s, e, n] : pad(center, 6),
      populationHint: pop && Number.isFinite(pop) ? pop : undefined,
      populationHintYear: it.extratags?.["population:date"],
      populationHintSource: pop ? "OpenStreetMap" : undefined,
    };
  });
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ results: [] });

  // Server-side token wins so the client token can stay unset; either works.
  const token =
    process.env.MAPBOX_SECRET_TOKEN?.trim() ||
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN?.trim() ||
    "";

  try {
    if (token) {
      try {
        const results = await viaMapbox(q, token);
        if (results.length) return NextResponse.json({ results, provider: "mapbox" });
        console.warn("[geocode] mapbox returned 0 results for %j; falling back", q);
      } catch (err) {
        // Never fail the request on this — but never swallow it silently either.
        console.warn(
          "[geocode] mapbox failed (%s); falling back to nominatim",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const results = await viaNominatim(q);
    return NextResponse.json({ results, provider: "nominatim" });
  } catch (err) {
    console.error(
      "[geocode] all providers failed for %j: %s",
      q,
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { results: [], error: "Geocoding is temporarily unavailable." },
      { status: 200 },
    );
  }
}
