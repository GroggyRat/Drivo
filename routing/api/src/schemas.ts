import { z } from "zod";

// Same shapes as web/src/lib/routing/types.ts.
const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const objective = z.enum(["lowest_fuel", "fastest", "shortest"]);
export type Objective = z.infer<typeof objective>;

export const planRequest = z.object({
  depot: lngLat,
  departureAt: z.string().datetime({ offset: true }),
  capacityCartons: z.number().int().positive().nullish(),
  litresPer100Km: z.number().positive().max(99).optional(),
  stops: z
    .array(z.object({ id: z.string().min(1).max(100), position: lngLat, serviceS: z.number().int().min(0).max(7200), cartons: z.number().int().min(0).optional() }))
    .min(1)
    .max(300),
});
export type PlanRequest = z.infer<typeof planRequest>;

export const planBody = planRequest.extend({ objectives: z.array(objective).min(1).max(3).default(["lowest_fuel", "fastest", "shortest"]) });
export const sequenceBody = planRequest.extend({ objective });

export const mapMatchBody = z.object({
  points: z.array(z.object({ lon: z.number(), lat: z.number(), time: z.number().int() })).min(2).max(20000),
});

export type Leg = { toStopId: string | null; distanceM: number; durationS: number };
export type RouteOption = {
  objective: Objective;
  order: string[];
  legs: Leg[];
  distanceM: number;
  durationS: number;
  etas: string[];
  returnAt: string;
  geometry: [number, number][];
  source: "routing_server";
};
