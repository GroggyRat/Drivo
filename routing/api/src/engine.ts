import { decodePolyline6 } from "./polyline.js";
import type { Leg, Objective, PlanRequest, RouteOption } from "./schemas.js";

type Fetch = typeof fetch;

export type EngineConfig = { valhallaUrl: string; vroomUrl: string; costing: string; fetch?: Fetch };

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
    const r = await this.post<{ sources_to_targets: { time: number | null; distance: number | null }[][] }>(
      `${this.cfg.valhallaUrl}/sources_to_targets`,
      { sources: locs, targets: locs, costing: this.cfg.costing },
    );
    const durations = r.sources_to_targets.map((row) => row.map((c) => (c.time == null ? 9_999_999 : Math.round(c.time))));
    const distances = r.sources_to_targets.map((row) => row.map((c) => (c.distance == null ? 9_999_999 : Math.round(c.distance * 1000))));
    return { durations, distances };
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
      vehicles: [{ id: 1, profile: "car", start_index: 0, end_index: 0, ...(withCapacity ? { capacity: [req.capacityCartons] } : {}) }],
      jobs: req.stops.map((s, i) => ({ id: i + 1, location_index: i + 1, service: s.serviceS, ...(withCapacity ? { delivery: [s.cartons ?? 0] } : {}) })),
      matrices: { car: { durations: m.durations, distances: m.distances, costs: RoutingEngine.costs(objective, m, req.litresPer100Km) } },
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
    const r = await this.post<{ trip: { legs: { shape: string; summary: { time: number; length: number } }[] } }>(`${this.cfg.valhallaUrl}/route`, {
      locations: points.map((p) => ({ ...this.loc(p), type: "break" })),
      costing: this.cfg.costing,
      costing_options: objective === "shortest" ? { [this.cfg.costing]: { shortest: true } } : undefined,
      directions_type: "none",
      units: "kilometers",
    });
    const legs: Leg[] = r.trip.legs.map((l, i) => ({ toStopId: order[i] ?? null, distanceM: Math.round(l.summary.length * 1000), durationS: Math.round(l.summary.time) }));
    const geometry: [number, number][] = [];
    for (const l of r.trip.legs) {
      const pts = decodePolyline6(l.shape);
      geometry.push(...(geometry.length ? pts.slice(1) : pts));
    }
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

export class UpstreamError extends Error {
  constructor(readonly service: "valhalla" | "vroom", readonly status: number, detail: string) {
    super(`${service} answered ${status}: ${detail}`);
  }
}

export class PlanningError extends Error {}
