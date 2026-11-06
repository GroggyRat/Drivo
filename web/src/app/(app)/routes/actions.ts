"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireManager } from "@/lib/tenant";

const saveSchema = z.object({
  id: z.string().uuid().nullish(),
  name: z.string().max(200).nullish(),
  routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  depotId: z.string().uuid(),
  optimiseFor: z.enum(["lowest_fuel", "fastest", "shortest"]),
  departureAt: z.string(),
  driverId: z.string().uuid().nullish(),
  vehicleId: z.string().uuid().nullish(),
  distanceM: z.number(),
  durationS: z.number(),
  fuelLitres: z.number().nullish(),
  geometry: z.array(z.tuple([z.number(), z.number()])).min(2),
  stops: z.array(z.object({ locationId: z.string().uuid(), orderId: z.string().uuid().nullish(), eta: z.string().nullish() })).min(1),
  send: z.boolean(),
});

export type SaveRouteInput = z.infer<typeof saveSchema>;

export async function saveRoute(input: SaveRouteInput): Promise<{ id?: string; error?: string }> {
  const ctx = await requireManager();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { error: "Some route details are missing" };
  const d = parsed.data;
  if (d.send && (!d.driverId || !d.vehicleId)) return { error: "Choose a driver and a vehicle before sending" };

  const { data: id, error } = await ctx.supabase.rpc("save_route", {
    p_tenant_id: ctx.tenant.id,
    p_route: {
      id: d.id ?? null,
      name: d.name ?? null,
      route_date: d.routeDate,
      depot_id: d.depotId,
      optimise_for: d.optimiseFor,
      departure_at: d.departureAt,
      driver_id: d.driverId ?? null,
      vehicle_id: d.vehicleId ?? null,
      planned_distance_m: Math.round(d.distanceM),
      planned_duration_s: Math.round(d.durationS),
      fuel_estimate_l: d.fuelLitres ?? null,
      geometry: { type: "LineString", coordinates: d.geometry },
      stops: d.stops.map((s) => ({ location_id: s.locationId, order_id: s.orderId ?? null, planned_eta: s.eta ?? null })),
    },
  });
  if (error) return { error: error.message };
  if (d.send) {
    const sent = await ctx.supabase.rpc("send_route", { p_route_id: id });
    if (sent.error) return { id, error: `Saved as a draft, but not sent: ${sent.error.message}` };
  }
  revalidatePath("/routes");
  revalidatePath("/");
  return { id };
}

export async function sendRoute(id: string) {
  const ctx = await requireManager();
  const { error } = await ctx.supabase.rpc("send_route", { p_route_id: id });
  revalidatePath(`/routes/${id}`);
  return error ? { error: error.message } : { ok: true };
}

export async function cancelRoute(formData: FormData) {
  const ctx = await requireManager();
  const id = String(formData.get("id"));
  await ctx.supabase.rpc("cancel_route", { p_route_id: id });
  revalidatePath(`/routes/${id}`);
  revalidatePath("/routes");
}
