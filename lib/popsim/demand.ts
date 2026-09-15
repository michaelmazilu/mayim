/**
 * Household clusters: buildings grouped into 50 m cells. At a walking speed of
 * 4 km/h, 50 m is under a minute, so nothing a household would notice is lost,
 * and a town of 30,000 buildings becomes a few thousand demand points.
 */
import { SERVICE } from "@/lib/config/coefficients";
import type { Scale } from "@/lib/popsim/network";

export const CLUSTER_M = 50;
export const PEOPLE_PER_BUILDING = (SERVICE.peoplePerBuilding.low + SERVICE.peoplePerBuilding.high) / 2;

export type Clusters = {
  /** People assumed per mapped building (one household per building). */
  peoplePerBuilding: number;
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  people: Float64Array;
  buildings: number;
};

export function clusterBuildings(
  points: { lon: number; lat: number }[],
  buildingWeight: number,
  scale: Scale,
  peoplePerBuilding: number = PEOPLE_PER_BUILDING,
): Clusters {
  const cells = new Map<string, { lon: number; lat: number; count: number; gx: number; gy: number }>();
  for (const p of points) {
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
    const gx = Math.floor((p.lon * scale.mLon) / CLUSTER_M);
    const gy = Math.floor((p.lat * scale.mLat) / CLUSTER_M);
    const k = `${gx},${gy}`;
    const c = cells.get(k);
    if (c) {
      c.lon += p.lon;
      c.lat += p.lat;
      c.count++;
    } else cells.set(k, { lon: p.lon, lat: p.lat, count: 1, gx, gy });
  }
  const list = [...cells.values()].sort((a, b) => a.gy - b.gy || a.gx - b.gx);
  const n = list.length;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const people = new Float64Array(n);
  let buildings = 0;
  list.forEach((c, i) => {
    lon[i] = c.lon / c.count;
    lat[i] = c.lat / c.count;
    people[i] = c.count * buildingWeight * peoplePerBuilding;
    buildings += c.count;
  });
  return { peoplePerBuilding, n, lon, lat, people, buildings: Math.round(buildings * buildingWeight) };
}
