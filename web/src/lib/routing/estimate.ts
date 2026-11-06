import { haversine, type LngLat } from "@/lib/geo";
import type { Objective, PlanRequest, RouteOption, RoutingProvider, Leg } from "./types";

// Straight-line estimates, for when the routing server is not connected
// (local development and previews). Distances are great-circle distance x a
// road factor; time uses an average speed. The app labels these as
// estimates. Production planning uses the routing server.

export const ROAD_FACTOR = 1.35;
export const AVERAGE_KMH = 38;

function legCost(a: LngLat, b: LngLat) {
  const distanceM = haversine(a, b) * ROAD_FACTOR;
  return { distanceM, durationS: (distanceM / 1000 / AVERAGE_KMH) * 3600 };
}

function tourLength(points: LngLat[], order: number[]) {
  let total = 0;
  let prev = 0;
  for (const i of order) {
    total += haversine(points[prev], points[i]);
    prev = i;
  }
  return total + haversine(points[prev], points[0]);
}

/** Nearest neighbour from the depot, improved with 2-opt. Index 0 is the depot. */
export function orderStops(points: LngLat[]): number[] {
  const remaining = new Set(points.map((_, i) => i).slice(1));
  const order: number[] = [];
  let current = 0;
  while (remaining.size) {
    let best = -1;
    let bestD = Infinity;
    for (const i of remaining) {
      const d = haversine(points[current], points[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    order.push(best);
    remaining.delete(best);
    current = best;
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        if (tourLength(points, candidate) + 0.01 < tourLength(points, order)) {
          order.splice(0, order.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return order;
}

export function buildOption(request: PlanRequest, orderIds: string[], objective: Objective): RouteOption {
  const byId = new Map(request.stops.map((s) => [s.id, s]));
  const legs: Leg[] = [];
  const etas: string[] = [];
  const geometry: LngLat[] = [request.depot];
  let clock = new Date(request.departureAt).getTime();
  let from = request.depot;
  for (const id of orderIds) {
    const stop = byId.get(id)!;
    const leg = legCost(from, stop.position);
    legs.push({ toStopId: id, distanceM: Math.round(leg.distanceM), durationS: Math.round(leg.durationS) });
    clock += leg.durationS * 1000;
    etas.push(new Date(clock).toISOString());
    clock += stop.serviceS * 1000;
    geometry.push(stop.position);
    from = stop.position;
  }
  const back = legCost(from, request.depot);
  legs.push({ toStopId: null, distanceM: Math.round(back.distanceM), durationS: Math.round(back.durationS) });
  clock += back.durationS * 1000;
  geometry.push(request.depot);
  const start = new Date(request.departureAt).getTime();
  const durationS = Math.round((clock - start) / 1000);
  return {
    objective,
    order: orderIds,
    legs,
    distanceM: legs.reduce((s, l) => s + l.distanceM, 0),
    durationS,
    etas,
    returnAt: new Date(start + durationS * 1000).toISOString(),
    geometry,
    source: "estimate",
  };
}

export class EstimateRoutingProvider implements RoutingProvider {
  readonly source = "estimate" as const;

  async plan(request: PlanRequest, objectives: Objective[] = ["lowest_fuel", "fastest", "shortest"]) {
    const points = [request.depot, ...request.stops.map((s) => s.position)];
    const ids = orderStops(points).map((i) => request.stops[i - 1].id);
    // Without road data every objective gives the same straight-line order.
    return objectives.map((o) => buildOption(request, ids, o));
  }

  async sequence(request: PlanRequest, objective: Objective) {
    return buildOption(request, request.stops.map((s) => s.id), objective);
  }
}
