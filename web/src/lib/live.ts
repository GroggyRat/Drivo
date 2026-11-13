import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { todayIn } from "@/lib/format";
import type { Tenant } from "@/lib/tenant";

export type VehicleStatus = "moving" | "stopped" | "over_limit" | "no_signal" | "not_started" | "finished";

export type LiveVehicle = {
  driverId: string;
  driverName: string;
  phone: string | null;
  email: string | null;
  vehicleId: string | null;
  plate: string | null;
  vehicleModel: string | null;
  routeId: string | null;
  routeName: string | null;
  position: [number, number] | null;
  heading: number | null;
  speedKmh: number | null;
  recordedAt: string | null;
  status: VehicleStatus;
  stopsDone: number;
  stopsTotal: number;
  nextStop: string | null;
  /** When the driver's open shift started, if they are on shift. */
  onShiftSince: string | null;
};

export type LiveAlert = {
  id: string;
  driverName: string;
  plate: string | null;
  startedAt: string;
  durationS: number;
  maxSpeedKmh: number;
  limitKmh: number;
  zoneName: string | null;
  position: [number, number];
  acknowledged: boolean;
};

export type LiveSnapshot = {
  generatedAt: string;
  vehicles: LiveVehicle[];
  alerts: LiveAlert[];
  routeLines: { routeId: string; coordinates: [number, number][] }[];
  summary: { onTheRoad: number; delivered: number; plannedStops: number; distanceM: number; openAlerts: number };
};

const SIGNAL_LOST_MS = 10 * 60_000;

export async function buildLiveSnapshot(supabase: SupabaseClient, tenant: Tenant): Promise<LiveSnapshot> {
  const today = todayIn(tenant.time_zone);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [{ data: routes }, { data: people }, { data: vehicles }, { data: positions }, { data: alerts }, { data: shifts }] = await Promise.all([
    supabase
      .from("routes")
      .select("id, name, status, driver_id, vehicle_id, planned_distance_m, geometry_geojson, route_stops(id, sequence, status, location:locations(name))")
      .eq("tenant_id", tenant.id)
      .eq("route_date", today)
      .in("status", ["sent", "in_progress", "completed"]),
    supabase.from("memberships").select("user_id, full_name, role, phone, email").eq("tenant_id", tenant.id),
    supabase.from("vehicles").select("id, plate, model").eq("tenant_id", tenant.id),
    supabase.from("driver_positions").select("driver_id, vehicle_id, route_id, recorded_at, lon, lat, speed_kmh, heading_deg").eq("tenant_id", tenant.id),
    supabase
      .from("speed_events")
      .select("id, driver_id, vehicle_id, started_at, duration_s, max_speed_kmh, limit_kmh, zone_name, lon, lat, acknowledged_at")
      .eq("tenant_id", tenant.id)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(50),
    supabase.from("shifts").select("driver_id, started_at").eq("tenant_id", tenant.id).is("ended_at", null),
  ]);

  const name = new Map((people ?? []).map((p) => [p.user_id as string, p.full_name as string]));
  const person = new Map((people ?? []).map((p) => [p.user_id as string, p]));
  const plate = new Map((vehicles ?? []).map((v) => [v.id as string, v.plate as string]));
  const model = new Map((vehicles ?? []).map((v) => [v.id as string, (v.model as string | null) ?? null]));
  const shiftStart = new Map((shifts ?? []).map((s) => [s.driver_id as string, s.started_at as string]));
  const now = Date.now();
  const recentAlertDrivers = new Set(
    (alerts ?? []).filter((a) => now - new Date(a.started_at).getTime() < 5 * 60_000).map((a) => a.driver_id as string),
  );

  type RouteRow = {
    id: string; name: string | null; status: string; driver_id: string; vehicle_id: string | null; planned_distance_m: number | null;
    geometry_geojson: { coordinates: [number, number][] } | null;
    route_stops: { id: string; sequence: number; status: string; location: { name: string } | null }[];
  };
  const routeRows = (routes ?? []) as unknown as RouteRow[];
  const posByDriver = new Map((positions ?? []).map((p) => [p.driver_id as string, p]));
  const driverIds = new Set([...routeRows.map((r) => r.driver_id), ...posByDriver.keys()]);

  const vehiclesOut: LiveVehicle[] = [...driverIds].map((driverId) => {
    const route = routeRows.find((r) => r.driver_id === driverId && r.status === "in_progress") ?? routeRows.find((r) => r.driver_id === driverId);
    const pos = posByDriver.get(driverId);
    const stops = [...(route?.route_stops ?? [])].sort((a, b) => a.sequence - b.sequence);
    const done = stops.filter((s) => !["scheduled", "arrived"].includes(s.status)).length;
    const next = stops.find((s) => ["scheduled", "arrived"].includes(s.status));
    const age = pos ? now - new Date(pos.recorded_at).getTime() : Infinity;
    const speed = pos?.speed_kmh != null ? Number(pos.speed_kmh) : null;
    let status: VehicleStatus = "not_started";
    if (route?.status === "completed") status = "finished";
    else if (pos && age > SIGNAL_LOST_MS) status = "no_signal";
    else if (pos && recentAlertDrivers.has(driverId)) status = "over_limit";
    else if (pos && (speed ?? 0) > 3) status = "moving";
    else if (pos) status = "stopped";
    const vehicleId = (route?.vehicle_id ?? pos?.vehicle_id ?? null) as string | null;
    return {
      driverId,
      driverName: name.get(driverId) ?? "Driver",
      phone: (person.get(driverId)?.phone as string | null | undefined) ?? null,
      email: (person.get(driverId)?.email as string | null | undefined) ?? null,
      vehicleId,
      plate: vehicleId ? plate.get(vehicleId) ?? null : null,
      vehicleModel: vehicleId ? model.get(vehicleId) ?? null : null,
      routeId: route?.id ?? null,
      routeName: route?.name ?? null,
      position: pos ? [Number(pos.lon), Number(pos.lat)] : null,
      heading: pos?.heading_deg != null ? Number(pos.heading_deg) : null,
      speedKmh: speed,
      recordedAt: pos?.recorded_at ?? null,
      status,
      stopsDone: done,
      stopsTotal: stops.length,
      nextStop: next?.location?.name ?? null,
      onShiftSince: shiftStart.get(driverId) ?? null,
    };
  });

  const alertsOut: LiveAlert[] = (alerts ?? []).map((a) => ({
    id: a.id,
    driverName: name.get(a.driver_id) ?? "Driver",
    plate: a.vehicle_id ? plate.get(a.vehicle_id) ?? null : null,
    startedAt: a.started_at,
    durationS: a.duration_s,
    maxSpeedKmh: Number(a.max_speed_kmh),
    limitKmh: a.limit_kmh,
    zoneName: a.zone_name,
    position: [Number(a.lon), Number(a.lat)],
    acknowledged: !!a.acknowledged_at,
  }));

  const allStops = routeRows.flatMap((r) => r.route_stops);
  return {
    generatedAt: new Date().toISOString(),
    vehicles: vehiclesOut.sort((a, b) => a.driverName.localeCompare(b.driverName)),
    alerts: alertsOut,
    routeLines: routeRows
      .filter((r) => r.status === "in_progress" && r.geometry_geojson?.coordinates)
      .map((r) => ({ routeId: r.id, coordinates: r.geometry_geojson!.coordinates })),
    summary: {
      onTheRoad: vehiclesOut.filter((v) => v.status === "moving" || v.status === "stopped" || v.status === "over_limit").length,
      delivered: allStops.filter((s) => s.status === "delivered" || s.status === "partially_delivered").length,
      plannedStops: allStops.length,
      distanceM: routeRows.reduce((sum, r) => sum + (r.planned_distance_m ?? 0), 0),
      openAlerts: alertsOut.filter((a) => !a.acknowledged).length,
    },
  };
}
