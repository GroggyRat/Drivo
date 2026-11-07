import { haversine, type LngLat } from "@/lib/geo";

export type NavStep = { location: LngLat; instruction: string; type: string; modifier: string | null; distance: number };

/** Polyline with 6 decimal places (Drivo's navigation endpoint and Valhalla), as [lon, lat]. */
export function decodePolyline6(str: string): LngLat[] {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let r = 0, sh = 0, b: number;
      do {
        b = str.charCodeAt(i++) - 63;
        r |= (b & 0x1f) << sh;
        sh += 5;
      } while (b >= 0x20);
      const d = r & 1 ? ~(r >> 1) : r >> 1;
      if (k === 0) lat += d;
      else lon += d;
    }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

/**
 * The next manoeuvre ahead of the driver: the first step (after "depart")
 * whose turn point is not yet behind them. A turn point counts as passed when
 * the driver is closer to the following one than the step's own length
 * allows, or within 25 m of it.
 */
export function nextManeuver(steps: NavStep[], at: LngLat): { index: number; instruction: string; type: string; modifier: string | null; distanceM: number } | null {
  if (steps.length < 2) return null;
  for (let i = 1; i < steps.length; i++) {
    const d = haversine(at, steps[i].location);
    const following = steps[i + 1];
    const passed = d < 25 && following !== undefined;
    const beyond = following !== undefined && haversine(at, following.location) < steps[i].distance * 0.85 && d > 40;
    if (!passed && !beyond) return { index: i, instruction: steps[i].instruction, type: steps[i].type, modifier: steps[i].modifier, distanceM: d };
  }
  const last = steps[steps.length - 1];
  return { index: steps.length - 1, instruction: last.instruction, type: last.type, modifier: last.modifier, distanceM: haversine(at, last.location) };
}
