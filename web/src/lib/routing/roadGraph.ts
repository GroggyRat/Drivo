import type { LngLat } from "@/lib/geo";
import { loadRoadGraph, type Path, type RoadGraph, type Snap, type Weight } from "./graph";
import type { Leg, Objective, PlanRequest, RouteOption, RoutingProvider } from "./types";

// Plans routes on Drivo's own road graph (graph.ts), inside the web app. Used
// when no separate routing server is configured. The three options minimise
// travel time, distance, or fuel (distance at the vehicle's L/100 km plus
// idling), each with its own best stop order.

const WEIGHT: Record<Objective, Weight> = { fastest: "time", shortest: "distance", lowest_fuel: "fuel" };

export class RoadUnreachableError extends Error {}

export class RoadGraphRoutingProvider implements RoutingProvider {
  readonly source = "road_graph" as const;

  constructor(private readonly graph: RoadGraph) {}

  static load(): RoadGraphRoutingProvider | null {
    const graph = loadRoadGraph();
    return graph ? new RoadGraphRoutingProvider(graph) : null;
  }

  private snapAll(request: PlanRequest): Snap[] {
    const points: LngLat[] = [request.depot, ...request.stops.map((s) => s.position)];
    return points.map((p, i) => {
      const s = this.graph.snap(p);
      if (!s) {
        const what = i === 0 ? "The depot" : `Stop ${i}`;
        throw new RoadUnreachableError(`${what} is more than 2 km from any road Drivo knows. Check its pin.`);
      }
      return s;
    });
  }

  /** Paths between every pair of points (index 0 is the depot) for one weight. */
  private matrix(snaps: Snap[], weight: Weight, litres: number) {
    return snaps.map((from) => {
      const search = this.graph.search(from, weight, litres);
      return snaps.map((to) => this.graph.finish(search, to));
    });
  }

  async plan(request: PlanRequest, objectives: Objective[] = ["lowest_fuel", "fastest", "shortest"]) {
    const snaps = this.snapAll(request);
    const litres = request.litresPer100Km ?? 15;
    const matrices = objectives.map((objective) => {
      const m = this.matrix(snaps, WEIGHT[objective], litres);
      unreachable(m, request);
      return m;
    });
    const costs = matrices.map((m) => m.map((row) => row.map((p) => p?.cost ?? Infinity)));
    const orders = costs.map((c) => bestOrder(c));
    return objectives.map((objective, k) => {
      // The order search is approximate: if another option's order happens to be
      // better for this objective, use it, so Shortest is never longer than the others.
      const order = orders.reduce((best, o) => (tourCost(costs[k], o) < tourCost(costs[k], best) ? o : best), orders[k]);
      return this.build(request, objective, order.map((i) => request.stops[i - 1].id), (a, b) => matrices[k][a][b]!);
    });
  }

  async sequence(request: PlanRequest, objective: Objective) {
    const snaps = this.snapAll(request);
    const litres = request.litresPer100Km ?? 15;
    const cache = new Map<number, ReturnType<RoadGraph["search"]>>();
    const path = (a: number, b: number) => {
      if (!cache.has(a)) cache.set(a, this.graph.search(snaps[a], WEIGHT[objective], litres));
      const p = this.graph.finish(cache.get(a)!, snaps[b]);
      if (!p) throw new RoadUnreachableError(noRoadMessage(request, a, b));
      return p;
    };
    return this.build(request, objective, request.stops.map((s) => s.id), path);
  }

  private build(request: PlanRequest, objective: Objective, orderIds: string[], path: (a: number, b: number) => Path): RouteOption {
    const index = new Map(request.stops.map((s, i) => [s.id, i + 1]));
    const byId = new Map(request.stops.map((s) => [s.id, s]));
    const legs: Leg[] = [];
    const etas: string[] = [];
    const geometry: LngLat[] = [];
    const start = new Date(request.departureAt).getTime();
    let clock = start;
    let at = 0;
    const add = (to: number, toStopId: string | null) => {
      const p = path(at, to);
      legs.push({ toStopId, distanceM: Math.round(p.distanceM), durationS: Math.round(p.durationS) });
      for (const q of this.graph.line(p)) {
        const last = geometry[geometry.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) geometry.push(q);
      }
      clock += p.durationS * 1000;
      at = to;
    };
    for (const id of orderIds) {
      add(index.get(id)!, id);
      etas.push(new Date(clock).toISOString());
      clock += byId.get(id)!.serviceS * 1000;
    }
    add(0, null);
    const durationS = Math.round((clock - start) / 1000);
    return {
      objective,
      order: orderIds,
      legs,
      distanceM: legs.reduce((s, l) => s + l.distanceM, 0),
      durationS,
      etas,
      returnAt: new Date(start + durationS * 1000).toISOString(),
      geometry: simplify(geometry, 4),
      source: this.source,
    };
  }
}

function noRoadMessage(request: PlanRequest, a: number, b: number) {
  const name = (i: number) => (i === 0 ? "the depot" : `stop ${i}`);
  void request;
  return `There is no road from ${name(a)} to ${name(b)}. Stops on different islands need a route each.`;
}

function unreachable(m: (Path | null)[][], request: PlanRequest) {
  for (let i = 1; i < m.length; i++) {
    if (!m[0][i] || !m[i][0]) throw new RoadUnreachableError(noRoadMessage(request, m[0][i] ? i : 0, m[0][i] ? 0 : i));
  }
}

function tourCost(cost: number[][], order: number[]) {
  let total = 0, prev = 0;
  for (const i of order) { total += cost[prev][i]; prev = i; }
  return total + cost[prev][0];
}

/** Visiting order (indices 1..n) for a round trip from 0, on an asymmetric cost matrix. */
export function bestOrder(cost: number[][]): number[] {
  const n = cost.length - 1;
  if (n <= 0) return [];
  const tour = (order: number[]) => tourCost(cost, order);
  // Nearest neighbour from the depot.
  const left = new Set(Array.from({ length: n }, (_, i) => i + 1));
  let order: number[] = [];
  let at = 0;
  while (left.size) {
    let best = -1;
    for (const i of left) if (best < 0 || cost[at][i] < cost[at][best]) best = i;
    order.push(best); left.delete(best); at = best;
  }
  // Improve with 2-opt (reverse a run) and or-opt (move one stop), until neither helps.
  let current = tour(order);
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const c = tour(candidate);
        if (c + 1e-6 < current) { order = candidate; current = c; improved = true; }
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const candidate = [...order];
        const [s] = candidate.splice(i, 1);
        candidate.splice(j, 0, s);
        const c = tour(candidate);
        if (c + 1e-6 < current) { order = candidate; current = c; improved = true; }
      }
    }
  }
  return order;
}

/** Douglas-Peucker in metres, to keep long road lines small. */
function simplify(points: LngLat[], toleranceM: number): LngLat[] {
  if (points.length < 3) return points;
  const kx = Math.cos((points[0][1] * Math.PI) / 180) * 111_320;
  const ky = 110_540;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1, farD = toleranceM;
    const ax = points[a][0] * kx, ay = points[a][1] * ky, bx = points[b][0] * kx, by = points[b][1] * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = points[i][0] * kx, py = points[i][1] * ky;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > farD) { far = i; farD = d; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
