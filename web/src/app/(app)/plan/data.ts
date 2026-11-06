import "server-only";
import type { ManagerContext } from "@/lib/tenant";

export async function loadPlanningLists(ctx: ManagerContext) {
  const t = ctx.tenant.id;
  const [{ data: depots }, { data: vehicles }, { data: drivers }] = await Promise.all([
    ctx.supabase.from("depots").select("id, name, lon, lat").eq("tenant_id", t).eq("active", true).order("name"),
    ctx.supabase.from("vehicles").select("id, plate, model, fuel_l_per_100km, capacity_cartons").eq("tenant_id", t).eq("active", true).order("plate"),
    ctx.supabase.from("memberships").select("user_id, full_name").eq("tenant_id", t).eq("role", "driver").eq("active", true).order("full_name"),
  ]);
  return {
    depots: (depots ?? []).map((d) => ({ id: d.id as string, name: d.name as string, position: [d.lon, d.lat] as [number, number] })),
    vehicles: (vehicles ?? []).map((v) => ({ id: v.id as string, plate: v.plate as string, model: v.model as string | null, fuel: Number(v.fuel_l_per_100km), capacity: v.capacity_cartons as number | null })),
    drivers: (drivers ?? []).map((d) => ({ id: d.user_id as string, name: d.full_name as string })),
  };
}
