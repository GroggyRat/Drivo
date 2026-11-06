// Turns map-matched edges into hourly average speeds per OSM way, for
// segment_speeds and, later, Valhalla historical traffic.

export type Point = [number, number, number, number, number, number]; // [epoch_ms, lon, lat, accuracy_m, speed_mps, heading]
export type MatchedEdge = { wayId: number; lengthM: number; speedKmh: number; forward: boolean };
export type SegmentRow = { osm_way_id: number; forward: boolean; weekday: number; hour: number; samples: number; mean_speed_kmh: number };

/** ISO weekday (1 = Monday) and hour in a time zone. */
export function localWeekdayHour(epochMs: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(epochMs))
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { weekday, hour: Number(parts.hour) };
}

/**
 * Group edges into (way, direction, weekday, hour) with a length-weighted
 * mean speed. Edges shorter than 50 m or under 3 km/h (stopped at a shop)
 * are left out so deliveries do not look like traffic.
 */
export function aggregateSpeeds(edges: (MatchedEdge & { at: number })[], timeZone: string): SegmentRow[] {
  const groups = new Map<string, { row: SegmentRow; weighted: number; length: number }>();
  for (const e of edges) {
    if (e.lengthM < 50 || e.speedKmh < 3 || e.speedKmh > 150) continue;
    const { weekday, hour } = localWeekdayHour(e.at, timeZone);
    const key = `${e.wayId}:${e.forward}:${weekday}:${hour}`;
    const g = groups.get(key) ?? { row: { osm_way_id: e.wayId, forward: e.forward, weekday, hour, samples: 0, mean_speed_kmh: 0 }, weighted: 0, length: 0 };
    g.row.samples += 1;
    g.weighted += e.speedKmh * e.lengthM;
    g.length += e.lengthM;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g.row, mean_speed_kmh: Math.round((g.weighted / g.length) * 10) / 10 }));
}

/** Points sorted by time without duplicates, and without fixes worse than 30 m. */
export function cleanPoints(points: Point[]): Point[] {
  const seen = new Set<number>();
  return points
    .filter((p) => p[3] <= 30)
    .sort((a, b) => a[0] - b[0])
    .filter((p) => (seen.has(p[0]) ? false : (seen.add(p[0]), true)));
}

/** Raw points as gzip-ready NDJSON, one point per line. */
export function toNdjson(points: Point[]): string {
  return points.map((p) => JSON.stringify({ t: p[0], lon: p[1], lat: p[2], acc: p[3], mps: p[4], hdg: p[5] })).join("\n") + "\n";
}
