import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { estimateFuel, fuelFormula } from "@/lib/fuel";
import type { LngLat } from "@/lib/geo";
import type { Objective, PlanRequest, RouteOption } from "@/lib/routing/types";
import type { Tenant } from "@/lib/tenant";

/** Minutes at a stop: 6 minutes plus 1 minute per 10 cartons. */
export const serviceSeconds = (cartons: number) => (6 + Math.ceil(cartons / 10)) * 60;

export type StopMeta = {
  /** The order id, or loc:<location id> for a stop without an order. */
  key: string;
  orderId: string | null;
  locationId: string;
  name: string;
  reference: string | null;
  customer: string | null;
  cartons: number;
  position: LngLat;
};

export type FuelInfo = { litres: number; cost: number | null; formula: string; currency: string };
export type PlannedOption = RouteOption & { fuel: FuelInfo | null };

export type PlanInputs = {
  depot: { id: string; name: string; position: LngLat };
  vehicle: { id: string; plate: string; fuel_l_per_100km: number; capacity_cartons: number | null } | null;
  settings: { fuel_price_per_l: number | null; idle_fuel_l_per_stop: number; currency: string };
  stops: StopMeta[];
};

export async function loadPlanInputs(
  supabase: SupabaseClient,
  tenant: Tenant,
  { orderIds, locationIds = [], depotId, vehicleId }: { orderIds: string[]; locationIds?: string[]; depotId: string; vehicleId?: string | null },
): Promise<PlanInputs> {
  const [{ data: depot }, { data: vehicle }, { data: settings }, { data: orders }, { data: locations }] = await Promise.all([
    supabase.from("depots").select("id, name, lon, lat").eq("tenant_id", tenant.id).eq("id", depotId).single(),
    vehicleId
      ? supabase.from("vehicles").select("id, plate, fuel_l_per_100km, capacity_cartons").eq("tenant_id", tenant.id).eq("id", vehicleId).single()
      : Promise.resolve({ data: null }),
    supabase.from("tenant_settings").select("fuel_price_per_l, idle_fuel_l_per_stop, currency").eq("tenant_id", tenant.id).single(),
    orderIds.length
      ? supabase
          .from("orders")
          .select("id, reference, customer_name, cartons, customer:customers(location:locations(id, name, lon, lat, status))")
          .eq("tenant_id", tenant.id)
          .in("id", orderIds)
      : Promise.resolve({ data: [] }),
    locationIds.length
      ? supabase.from("locations").select("id, name, lon, lat, status").eq("tenant_id", tenant.id).in("id", locationIds)
      : Promise.resolve({ data: [] }),
  ]);
  if (!depot) throw new Error("Choose a depot");

  type OrderRow = { id: string; reference: string; customer_name: string; cartons: number; customer: { location: { id: string; name: string; lon: number; lat: number; status: string } | null } | null };
  const stops: StopMeta[] = [];
  for (const id of orderIds) {
    const o = ((orders ?? []) as unknown as OrderRow[]).find((x) => x.id === id);
    const loc = o?.customer?.location;
    if (!o || !loc || loc.status !== "approved") throw new Error("Every selected invoice needs an approved location");
    stops.push({ key: o.id, orderId: o.id, locationId: loc.id, name: loc.name, reference: o.reference, customer: o.customer_name, cartons: o.cartons, position: [loc.lon, loc.lat] });
  }
  for (const l of (locations ?? []) as { id: string; name: string; lon: number; lat: number }[]) {
    stops.push({ key: `loc:${l.id}`, orderId: null, locationId: l.id, name: l.name, reference: null, customer: null, cartons: 0, position: [l.lon, l.lat] });
  }

  return {
    depot: { id: depot.id, name: depot.name, position: [depot.lon, depot.lat] },
    vehicle: (vehicle as PlanInputs["vehicle"]) ?? null,
    settings: {
      fuel_price_per_l: settings?.fuel_price_per_l != null ? Number(settings.fuel_price_per_l) : null,
      idle_fuel_l_per_stop: Number(settings?.idle_fuel_l_per_stop ?? 0.1),
      currency: settings?.currency ?? "FJD",
    },
    stops,
  };
}

export function toPlanRequest(inputs: PlanInputs, departureAt: string, orderKeys?: string[]): PlanRequest {
  const byKey = new Map(inputs.stops.map((s) => [s.key, s]));
  const stops = (orderKeys ?? inputs.stops.map((s) => s.key)).map((k) => byKey.get(k)!).filter(Boolean);
  return {
    depot: inputs.depot.position,
    departureAt,
    capacityCartons: inputs.vehicle?.capacity_cartons ?? null,
    litresPer100Km: inputs.vehicle ? Number(inputs.vehicle.fuel_l_per_100km) : undefined,
    stops: stops.map((s) => ({ id: s.key, position: s.position, serviceS: serviceSeconds(s.cartons), cartons: s.cartons })),
  };
}

export function withFuel(option: RouteOption, inputs: PlanInputs): PlannedOption {
  if (!inputs.vehicle) return { ...option, fuel: null };
  const f = {
    distanceM: option.distanceM,
    litresPer100Km: Number(inputs.vehicle.fuel_l_per_100km),
    stops: option.order.length,
    idleLitresPerStop: inputs.settings.idle_fuel_l_per_stop,
    pricePerLitre: inputs.settings.fuel_price_per_l,
  };
  const r = estimateFuel(f);
  return { ...option, fuel: { litres: r.litres, cost: r.cost, formula: fuelFormula(f), currency: inputs.settings.currency } };
}

export const OBJECTIVE_ORDER: Objective[] = ["lowest_fuel", "fastest", "shortest"];
