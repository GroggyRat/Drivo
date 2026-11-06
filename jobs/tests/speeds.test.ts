import { describe, expect, it } from "vitest";
import { aggregateSpeeds, cleanPoints, localWeekdayHour, toNdjson, type Point } from "../src/speeds.js";

describe("nightly speed aggregation", () => {
  it("uses the tenant's local weekday and hour", () => {
    // Thursday 05/11/2026 20:30 UTC is Friday 06/11 08:30 in Fiji.
    expect(localWeekdayHour(Date.parse("2026-11-05T20:30:00Z"), "Pacific/Fiji")).toEqual({ weekday: 5, hour: 8 });
  });

  it("averages speeds per way, direction and hour, weighted by length, ignoring stops and short edges", () => {
    const at = Date.parse("2026-11-05T20:30:00Z");
    const rows = aggregateSpeeds(
      [
        { wayId: 1, forward: true, lengthM: 300, speedKmh: 40, at },
        { wayId: 1, forward: true, lengthM: 100, speedKmh: 20, at },
        { wayId: 1, forward: false, lengthM: 200, speedKmh: 30, at },
        { wayId: 2, forward: true, lengthM: 20, speedKmh: 50, at },
        { wayId: 3, forward: true, lengthM: 400, speedKmh: 1, at },
      ],
      "Pacific/Fiji",
    );
    expect(rows).toEqual([
      { osm_way_id: 1, forward: true, weekday: 5, hour: 8, samples: 2, mean_speed_kmh: 35 },
      { osm_way_id: 1, forward: false, weekday: 5, hour: 8, samples: 1, mean_speed_kmh: 30 },
    ]);
  });

  it("drops inaccurate and duplicate fixes and sorts by time before archiving", () => {
    const pts: Point[] = [[3000, 178.4, -18.1, 5, 1, 0], [1000, 178.4, -18.1, 5, 1, 0], [2000, 178.4, -18.1, 45, 1, 0], [1000, 178.4, -18.1, 5, 1, 0]];
    expect(cleanPoints(pts).map((p) => p[0])).toEqual([1000, 3000]);
    expect(toNdjson(cleanPoints(pts)).trim().split("\n")).toHaveLength(2);
  });
});
