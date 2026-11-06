import type { LngLat } from "@/lib/geo";

// RoutingProvider: the only way the app asks for routes. Drivo routes on its
// own Fiji road graph inside the web app (roadGraph.ts); a separate routing
// server (Valhalla and VROOM, routing/) is used instead when configured, and
// straight-line estimates only when neither is available.

export type Objective = "lowest_fuel" | "fastest" | "shortest";
export const OBJECTIVES: Objective[] = ["lowest_fuel", "fastest", "shortest"];
export const OBJECTIVE_LABEL: Record<Objective, string> = {
  lowest_fuel: "Lowest fuel use",
  fastest: "Fastest",
  shortest: "Shortest distance",
};

export type PlanStop = {
  id: string;
  position: LngLat;
  /** Minutes spent at the stop. */
  serviceS: number;
  cartons?: number;
};

export type PlanRequest = {
  depot: LngLat;
  stops: PlanStop[];
  departureAt: string;
  capacityCartons?: number | null;
  /** Fuel use per km relative to time, used to rank the lowest-fuel option. */
  litresPer100Km?: number;
};

export type Leg = { toStopId: string | null; distanceM: number; durationS: number };

export type RouteOption = {
  objective: Objective;
  /** Stop ids in visiting order. */
  order: string[];
  legs: Leg[];
  distanceM: number;
  durationS: number;
  /** Planned arrival at each stop, ISO time, same order as `order`. */
  etas: string[];
  returnAt: string;
  geometry: LngLat[];
  source: "routing_server" | "road_graph" | "estimate";
};

export interface RoutingProvider {
  readonly source: RouteOption["source"];
  /** Optimised options, one per objective. */
  plan(request: PlanRequest, objectives?: Objective[]): Promise<RouteOption[]>;
  /** Times, distance and line for stops in a fixed order (after a manual reorder). */
  sequence(request: PlanRequest, objective: Objective): Promise<RouteOption>;
}
