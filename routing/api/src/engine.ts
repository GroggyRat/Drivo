import { decodePolyline6 } from "./polyline.js";
import type { Leg, Objective, PlanRequest, RouteOption } from "./schemas.js";

type Fetch = typeof fetch;

export type EngineConfig = { valhallaUrl: string; vroomUrl: string; costing: string; fetch?: Fetch };

const NOT_CONNECTED = "No road connects some of these stops, so they are probably on different islands. Plan a separate route for each island.";

/** Fuel at idle, litres per hour, for the lowest-fuel cost. */
const IDLE_LITRES_PER_HOUR = 1.0;

export class RoutingEngine {
  private readonly f: Fetch;
  constructor(private readonly cfg: EngineConfig) {
    this.f = cfg.fetch ?? fetch;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const res = await this.f(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(url.includes(this.cfg.vroomUrl) ? "vroom" : "valhalla", res.status, text.slice(0, 300));
    return JSON.parse(text) as T;
  }

  private loc = ([lon, lat]: [number, number]) => ({ lon, lat });

  /** Travel time (s) and distance (m) between every pair of points. */
  async matrix(points: [number, number][]) {
    const locs = points.map(this.loc);
    let r: { sources_to_targets: { time: number | null; distance: number | null }[][] };
    try {
      r = await this.post(`${this.cfg.valhallaUrl}/sources_to_targets`, { sources: locs, targets: locs, costing: this.cfg.costing });
    } catch (e) {
      if (e instanceof UpstreamError && /unconnected regions|No path/i.test(e.message)) throw new PlanningError(NOT_CONNECTED);
      throw e;
    }
    const durations = r.sources_to_targets.map((row) => row.map((c) => (c.time == null ? null : Math.round(c.time))));
    const distances = r.sources_to_targets.map((row) => row.map((c) => (c.distance == null ? null : Math.round(c.distance * 1000))));
    // Valhalla does not join roads across the 180 degree meridian (Taveuni).
    // Fill those pairs by routing through a crossing point.
    for (let i = 0; i < points.length; i++) {
      for (let j = 0; j < points.length; j++) {
        if (durations[i][j] != null || !straddles(points[i], points[j])) continue;
        const leg = await this.legAcrossMeridian(points[i], points[j]);
        if (leg) {
          durations[i][j] = Math.round(leg.time);
          distances[i][j] = Math.round(leg.length * 1000);
        }
      }
    }
    const unreachable = durations.some((row) => row.some((v) => v == null));
    if (unreachable) {
      const i = durations.findIndex((row) => row.some((v) => v == null));
      const j = durations[i].findIndex((v) => v == null);
      throw new PlanningError(`No road connects stop ${i === 0 ? "depot" : i} and ${j === 0 ? "depot" : j}. They may be on different islands: plan a route per island.`);
    }
    return { durations: durations as number[][], distances: distances as number[][] };
  }

  private crossings: [number, number][] | null = null;

  /**
   * Latitudes where roads cross the 180 degree meridian, found once by
   * snapping points on both sides of the line and keeping pairs that meet.
   */
  private async meridianCrossings(): Promise<[number, number][]> {
    if (this.crossings) return this.crossings;
    const found: [number, number][] = [];
    const lats: number[] = [];
    for (let lat = -15.6; lat >= -19.6; lat -= 0.005) lats.push(Math.round(lat * 1000) / 1000);
    const snap = async (lon: number) => {
      const r = await this.post<{ edges?: { correlated_lon: number; correlated_lat: number }[] }[]>(`${this.cfg.valhallaUrl}/locate`, {
        locations: lats.map((lat) => ({ lon, lat, radius: 60 })),
        costing: this.cfg.costing,
        verbose: false,
      });
      return r.map((x) => x.edges?.[0] ?? null);
    };
    const [west, east] = await Promise.all([snap(179.99995), snap(-179.99995)]);
    for (let k = 0; k < lats.length; k++) {
      const w = west[k];
      const e = east[k];
      if (!w || !e) continue;
      if (Math.abs(Math.abs(w.correlated_lon) - 180) > 0.0005 || Math.abs(Math.abs(e.correlated_lon) - 180) > 0.0005) continue;
      if (Math.abs(w.correlated_lat - e.correlated_lat) > 0.0005) continue;
      const lat = (w.correlated_lat + e.correlated_lat) / 2;
      if (!found.some(([, l]) => Math.abs(l - lat) < 0.003)) found.push([180, lat]);
    }
    this.crossings = found;
    return found;
  }

  /** Fastest road route between points on opposite sides of the meridian, as one leg. */
  async legAcrossMeridian(a: [number, number], b: [number, number]) {
    let best: { time: number; length: number; shape: [number, number][] } | null = null;
    for (const [, lat] of await this.meridianCrossings()) {
      const aSide: [number, number] = [a[0] > 0 ? 179.99999 : -179.99999, lat];
      const bSide: [number, number] = [b[0] > 0 ? 179.99999 : -179.99999, lat];
      try {
        const [first, second] = await Promise.all([this.simpleLeg(a, aSide), this.simpleLeg(bSide, b)]);
        const total = { time: first.time + second.time, length: first.length + second.length, shape: [...first.shape, ...second.shape] };
        if (!best || total.time < best.time) best = total;
      } catch {
        // This crossing does not connect these two points.
      }
    }
    return best;
  }

  private async simpleLeg(a: [number, number], b: [number, number]) {
    const r = await this.post<{ trip: { legs: { shape: string; summary: { time: number; length: number } }[] } }>(`${this.cfg.valhallaUrl}/route`, {
      locations: [this.loc(a), this.loc(b)],
      costing: this.cfg.costing,
      directions_type: "none",
      units: "kilometers",
    });
    const l = r.trip.legs[0];
    return { time: l.summary.time, length: l.summary.length, shape: decodePolyline6(l.shape) };
  }

  /** Cost matrix VROOM minimises for each objective. */
  static costs(objective: Objective, m: { durations: number[][]; distances: number[][] }, litresPer100Km = 12) {
    if (objective === "fastest") return m.durations;
    if (objective === "shortest") return m.distances;
    // Lowest fuel: millilitres burned driving the distance plus idling for the time.
    return m.distances.map((row, i) =>
      row.map((d, j) => Math.round((d * litresPer100Km) / 100 + (m.durations[i][j] * IDLE_LITRES_PER_HOUR * 1000) / 3600)),
    );
  }

  /** Stop order for one objective, from VROOM. */
  async order(req: PlanRequest, objective: Objective, m: { durations: number[][]; distances: number[][] }): Promise<string[]> {
    const withCapacity = req.capacityCartons != null;
    const body = {
      vehicles: [{ id: 1, profile: this.cfg.costing, start_index: 0, end_index: 0, ...(withCapacity ? { capacity: [req.capacityCartons] } : {}) }],
      jobs: req.stops.map((s, i) => ({ id: i + 1, location_index: i + 1, service: s.serviceS, ...(withCapacity ? { delivery: [s.cartons ?? 0] } : {}) })),
      matrices: { [this.cfg.costing]: { durations: m.durations, distances: m.distances, costs: RoutingEngine.costs(objective, m, req.litresPer100Km) } },
    };
    const r = await this.post<{ code: number; unassigned: { id: number }[]; routes: { steps: { type: string; job?: number }[] }[] }>(this.cfg.vroomUrl, body);
    if (r.code !== 0) throw new UpstreamError("vroom", 200, `VROOM code ${r.code}`);
    if (r.unassigned?.length) throw new PlanningError(`${r.unassigned.length} stops do not fit in the vehicle`);
    return r.routes[0].steps.filter((s) => s.type === "job").map((s) => req.stops[s.job! - 1].id);
  }

  /** Road line, legs and arrival times for stops in a fixed order. */
  async route(req: PlanRequest, order: string[], objective: Objective): Promise<RouteOption> {
    const byId = new Map(req.stops.map((s) => [s.id, s]));
    const points: [number, number][] = [req.depot, ...order.map((id) => byId.get(id)!.position), req.depot];
    let raw: { time: number; length: number; shape: [number, number][] }[];
    try {
      const r = await this.post<{ trip: { legs: { shape: string; summary: { time: number; length: number } }[] } }>(`${this.cfg.valhallaUrl}/route`, {
        locations: points.map((p) => ({ ...this.loc(p), type: "break" })),
        costing: this.cfg.costing,
        costing_options: objective === "shortest" ? { [this.cfg.costing]: { shortest: true } } : undefined,
        directions_type: "none",
        units: "kilometers",
      });
      raw = r.trip.legs.map((l) => ({ time: l.summary.time, length: l.summary.length, shape: decodePolyline6(l.shape) }));
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      if (!points.some((p, i) => i > 0 && straddles(points[i - 1], p))) {
        if (/unconnected regions|No path/i.test(e.message)) throw new PlanningError(NOT_CONNECTED);
        throw e;
      }
      // A leg crosses the 180 degree meridian: route leg by leg.
      raw = [];
      for (let i = 1; i < points.length; i++) {
        const leg = straddles(points[i - 1], points[i]) ? await this.legAcrossMeridian(points[i - 1], points[i]) : await this.simpleLeg(points[i - 1], points[i]);
        if (!leg) throw new PlanningError(NOT_CONNECTED);
        raw.push(leg);
      }
    }
    const legs: Leg[] = raw.map((l, i) => ({ toStopId: order[i] ?? null, distanceM: Math.round(l.length * 1000), durationS: Math.round(l.time) }));
    const geometry: [number, number][] = [];
    for (const l of raw) geometry.push(...(geometry.length ? l.shape.slice(1) : l.shape));
    const start = new Date(req.departureAt).getTime();
    let clock = start;
    const etas: string[] = [];
    legs.forEach((leg, i) => {
      clock += leg.durationS * 1000;
      if (i < order.length) {
        etas.push(new Date(clock).toISOString());
        clock += byId.get(order[i])!.serviceS * 1000;
      }
    });
    return {
      objective,
      order,
      legs,
      distanceM: legs.reduce((s, l) => s + l.distanceM, 0),
      durationS: Math.round((clock - start) / 1000),
      etas,
      returnAt: new Date(clock).toISOString(),
      geometry,
      source: "routing_server",
    };
  }

  async plan(req: PlanRequest, objectives: Objective[]): Promise<RouteOption[]> {
    const m = await this.matrix([req.depot, ...req.stops.map((s) => s.position)]);
    return Promise.all(objectives.map(async (o) => this.route(req, await this.order(req, o, m), o)));
  }

  /**
   * Snap a GPS trace to roads. Returns the matched line and, per OSM way,
   * the distance and average speed, for historical traffic.
   */
  async mapMatch(points: { lon: number; lat: number; time: number }[]) {
    const r = await this.post<{
      shape: string;
      edges: { way_id: number; length: number; speed: number; begin_shape_index: number; end_shape_index: number; forward?: boolean }[];
    }>(`${this.cfg.valhallaUrl}/trace_attributes`, {
      shape: points.map((p) => ({ lat: p.lat, lon: p.lon, time: p.time })),
      costing: this.cfg.costing,
      shape_match: "map_snap",
      filters: { attributes: ["edge.way_id", "edge.length", "edge.speed", "edge.begin_shape_index", "edge.end_shape_index", "edge.forward", "shape"], action: "include" },
    });
    return {
      geometry: decodePolyline6(r.shape),
      edges: r.edges.map((e) => ({ wayId: e.way_id, lengthM: Math.round(e.length * 1000), speedKmh: e.speed, forward: e.forward ?? true })),
    };
  }
}

/** True when two points are on opposite sides of the 180 degree meridian. */
export function straddles(a: [number, number], b: [number, number]) {
  return Math.abs(a[0]) > 170 && Math.abs(b[0]) > 170 && Math.sign(a[0]) !== Math.sign(b[0]);
}

export class UpstreamError extends Error {
  constructor(readonly service: "valhalla" | "vroom", readonly status: number, detail: string) {
    super(`${service} answered ${status}: ${detail}`);
  }
}

export class PlanningError extends Error {}
