import { describe, expect, it } from "vitest";
import type { LngLat } from "@/lib/geo";
import { loadRoadGraph } from "@/lib/routing/graph";
import { encodePolyline6, osrmResponse } from "@/lib/routing/osrm";

function decode6(s: string): LngLat[] {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => { let r = 0, shift = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < s.length) { lat += next(); lon += next(); out.push([lon / 1e6, lat / 1e6]); }
  return out;
}

const graph = loadRoadGraph()!;
const route = (a: LngLat, b: LngLat) => {
  const sa = graph.snap(a)!, sb = graph.snap(b)!;
  const p = graph.finish(graph.search(sa, "time"), sb)!;
  return osrmResponse(graph, [p], [sa.point, sb.point]);
};

describe("turn-by-turn in OSRM format for Ferrostar", () => {
  it("encodes polyline6 that decodes back", () => {
    const pts: LngLat[] = [[178.4419, -18.1416], [178.456789, -18.123456], [-179.88, -16.688]];
    expect(decode6(encodePolyline6(pts)).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)])).toEqual(pts);
  });

  it("gives Walu Bay to Nausori as depart, turns and arrive, with banners and voice", () => {
    const res = route([178.4335, -18.1262], [178.5603, -18.0313]);
    expect(res.code).toBe("Ok");
    const leg = res.routes[0].legs[0];
    const steps = leg.steps;
    expect(steps[0].maneuver.type).toBe("depart");
    expect(steps[steps.length - 1].maneuver.type).toBe("arrive");
    expect(steps.length).toBeGreaterThan(3);
    const total = steps.reduce((s, st) => s + st.distance, 0);
    expect(Math.abs(total - leg.distance)).toBeLessThan(leg.distance * 0.02 + 5);
    for (const [i, st] of steps.entries()) {
      expect(decode6(st.geometry).length).toBeGreaterThanOrEqual(2);
      if (i < steps.length - 1) expect(st.bannerInstructions.length).toBe(1);
      for (const v of st.voiceInstructions) expect(v.distanceAlongGeometry).toBeLessThanOrEqual(st.distance + 0.01);
    }
    expect(decode6(res.routes[0].geometry).length).toBeGreaterThan(20);
    console.log(steps.map((s) => `${s.maneuver.instruction} (${Math.round(s.distance)} m)`).join("\n"));
  });
});
