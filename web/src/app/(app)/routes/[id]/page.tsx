import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmSubmit } from "@/components/buttons";
import { RouteReview } from "@/components/planning/RouteReview";
import { Card, Notice, PageHeader, StatusBadge, TableWrap } from "@/components/ui";
import { formatDate, formatDistance, formatDuration, formatLitres, formatTime } from "@/lib/format";
import { loadPlanInputs, toPlanRequest, withFuel } from "@/lib/planning";
import { getRoutingProvider } from "@/lib/routing";
import type { Objective } from "@/lib/routing/types";
import { requireManager } from "@/lib/tenant";
import { loadPlanningLists } from "../../plan/data";
import { cancelRoute } from "../actions";
import { RouteMap } from "./RouteMap";

export const metadata: Metadata = { title: "Route" };
export const dynamic = "force-dynamic";

export default async function RoutePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const ctx = await requireManager();
  const { id } = await params;
  const { saved } = await searchParams;
  const tz = ctx.tenant.time_zone;
  const { data: route } = await ctx.supabase
    .from("routes")
    .select("*, depot:depots(id, name, lon, lat), vehicle:vehicles(plate, model), route_stops(id, sequence, status, planned_eta, arrived_at, completed_at, failure_reason, order_id, location:locations(id, name, lon, lat), order:orders(reference, customer_name, cartons))")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (!route) notFound();

  type Stop = { id: string; sequence: number; status: string; planned_eta: string | null; arrived_at: string | null; completed_at: string | null; failure_reason: string | null; order_id: string | null; location: { id: string; name: string; lon: number; lat: number }; order: { reference: string; customer_name: string; cartons: number } | null };
  const stops = ([...(route.route_stops as Stop[])]).sort((a, b) => a.sequence - b.sequence);
  const { data: driver } = route.driver_id
    ? await ctx.supabase.from("memberships").select("full_name").eq("tenant_id", ctx.tenant.id).eq("user_id", route.driver_id).maybeSingle()
    : { data: null };

  const header = (
    <PageHeader
      title={route.name ?? "Route"}
      description={`${formatDate(route.route_date)} from ${route.depot?.name}`}
      actions={
        <>
          <StatusBadge status={route.status} />
          <Link className="btn-secondary" href={`/routes?date=${route.route_date}`}>All routes that day</Link>
          {["draft", "sent", "in_progress"].includes(route.status) && (
            <form action={cancelRoute}>
              <input type="hidden" name="id" value={route.id} />
              <ConfirmSubmit
                label="Cancel route"
                title="Cancel this route?"
                message={<>Stops not yet delivered go back to Ready for delivery.{route.status === "in_progress" ? " The driver is on the road; call them as well." : ""}</>}
                confirmLabel="Cancel route"
                className="btn-danger"
              />
            </form>
          )}
        </>
      }
    />
  );

  if (route.status === "draft") {
    const keys = stops.map((s) => s.order_id ?? `loc:${s.location.id}`);
    const lists = await loadPlanningLists(ctx);
    const inputs = await loadPlanInputs(ctx.supabase, ctx.tenant, {
      orderIds: stops.filter((s) => s.order_id).map((s) => s.order_id!),
      locationIds: stops.filter((s) => !s.order_id).map((s) => s.location.id),
      depotId: route.depot_id,
      vehicleId: route.vehicle_id,
    });
    const departure = route.departure_at ?? new Date(`${route.route_date}T08:00:00+12:00`).toISOString();
    const option = withFuel(await getRoutingProvider().sequence(toPlanRequest(inputs, departure, keys), route.optimise_for as Objective), inputs);
    return (
      <>
        {header}
        {saved === "draft" && <div className="mb-4"><Notice tone="green">Draft saved. Send it to the driver when ready.</Notice></div>}
        <RouteReview
          routeId={route.id}
          depot={inputs.depot}
          stops={inputs.stops}
          options={[option]}
          initialObjective={route.optimise_for as Objective}
          drivers={lists.drivers}
          vehicles={lists.vehicles}
          timeZone={tz}
          defaults={{ name: route.name ?? "", routeDate: route.route_date, departureAt: departure, driverId: route.driver_id, vehicleId: route.vehicle_id }}
        />
      </>
    );
  }

  const done = stops.filter((s) => !["scheduled", "arrived"].includes(s.status)).length;
  return (
    <>
      {header}
      {saved === "sent" && <div className="mb-4"><Notice tone="green">Sent to {driver?.full_name ?? "the driver"}. It is on their phone now.</Notice></div>}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["Driver", driver?.full_name ?? "Not assigned"],
          ["Vehicle", route.vehicle?.plate ?? "Not assigned"],
          ["Stops done", `${done} of ${stops.length}`],
          ["Planned", `${formatDistance(route.planned_distance_m)}, ${formatDuration(route.planned_duration_s)}`],
          ["Fuel estimate", route.fuel_estimate_l ? formatLitres(Number(route.fuel_estimate_l)) : "None"],
        ].map(([k, v]) => (
          <div key={k} className="card p-3"><p className="text-xs text-muted">{k}</p><p className="font-semibold">{v}</p></div>
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_480px] [&>*]:min-w-0">
        <Card title="Map" bodyClassName="p-0">
          <RouteMap
            depot={{ name: route.depot?.name ?? "Depot", position: [route.depot?.lon, route.depot?.lat] }}
            stops={stops.map((s) => ({ id: s.id, sequence: s.sequence, name: s.location.name, position: [s.location.lon, s.location.lat], done: !["scheduled", "arrived"].includes(s.status) }))}
            line={(route.geometry_geojson as { coordinates: [number, number][] } | null)?.coordinates ?? []}
          />
        </Card>
        <Card title="Stops" bodyClassName="p-0">
          <TableWrap>
            <table className="data-table">
              <thead><tr><th scope="col">#</th><th scope="col">Stop</th><th scope="col">Planned</th><th scope="col">Arrived</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {stops.map((s) => (
                  <tr key={s.id}>
                    <td>{s.sequence}</td>
                    <td>
                      <p className="font-medium">{s.location.name}</p>
                      <p className="text-xs text-muted">{s.order ? `${s.order.reference}, ${s.order.cartons} cartons` : "No invoice"}</p>
                      {s.failure_reason && <p className="text-xs text-bad">{s.failure_reason}</p>}
                    </td>
                    <td>{formatTime(s.planned_eta, tz)}</td>
                    <td>{formatTime(s.arrived_at, tz)}</td>
                    <td>
                      {["delivered", "partially_delivered", "failed"].includes(s.status) ? (
                        <Link href={`/deliveries?date=${route.route_date}&stop=${s.id}`} className="no-underline"><StatusBadge status={s.status} /></Link>
                      ) : (
                        <StatusBadge status={s.status} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>
    </>
  );
}
