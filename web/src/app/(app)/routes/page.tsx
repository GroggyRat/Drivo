import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, PageHeader, StatusBadge, TableWrap } from "@/components/ui";
import { formatDate, formatDistance, formatDuration, formatLitres, formatTime, todayIn } from "@/lib/format";
import { requireManager } from "@/lib/tenant";

export const metadata: Metadata = { title: "Routes" };
export const dynamic = "force-dynamic";

export default async function RoutesPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const ctx = await requireManager();
  const { date: wanted } = await searchParams;
  const date = wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : todayIn(ctx.tenant.time_zone);
  const [{ data: routes }, { data: people }] = await Promise.all([
    ctx.supabase
      .from("routes")
      .select("id, name, status, departure_at, planned_distance_m, planned_duration_s, fuel_estimate_l, driver_id, vehicle:vehicles(plate), depot:depots(name), route_stops(status)")
      .eq("tenant_id", ctx.tenant.id)
      .eq("route_date", date)
      .order("departure_at", { ascending: true, nullsFirst: false }),
    ctx.supabase.from("memberships").select("user_id, full_name").eq("tenant_id", ctx.tenant.id),
  ]);
  const name = new Map((people ?? []).map((p) => [p.user_id, p.full_name]));
  type Row = { id: string; name: string | null; status: string; departure_at: string | null; planned_distance_m: number | null; planned_duration_s: number | null; fuel_estimate_l: string | null; driver_id: string | null; vehicle: { plate: string } | null; depot: { name: string } | null; route_stops: { status: string }[] };
  const rows = (routes ?? []) as unknown as Row[];
  const shift = (days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  return (
    <>
      <PageHeader
        title="Routes"
        description={`Routes for ${formatDate(date)}`}
        actions={
          <>
            <Link className="btn-secondary" href={`/routes?date=${shift(-1)}`}>Previous day</Link>
            <form className="flex gap-2">
              <label htmlFor="date" className="sr-only">Date</label>
              <input id="date" name="date" type="date" defaultValue={date} className="input w-40" />
              <button className="btn-secondary" type="submit">Show</button>
            </form>
            <Link className="btn-secondary" href={`/routes?date=${shift(1)}`}>Next day</Link>
            <Link className="btn-primary" href="/plan">Plan route</Link>
          </>
        }
      />
      <Card bodyClassName="p-0">
        {rows.length === 0 ? (
          <EmptyState title="No routes on this day"><Link href="/plan" className="link">Plan a route</Link></EmptyState>
        ) : (
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Route</th><th scope="col">Status</th><th scope="col">Driver</th><th scope="col">Vehicle</th>
                  <th scope="col">Leaves</th><th scope="col">Stops done</th><th scope="col">Distance</th><th scope="col">Time</th><th scope="col">Fuel</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const done = r.route_stops.filter((s) => !["scheduled", "arrived"].includes(s.status)).length;
                  return (
                    <tr key={r.id}>
                      <td><Link className="link" href={`/routes/${r.id}`}>{r.name ?? "Route"}</Link><p className="text-xs text-muted">{r.depot?.name}</p></td>
                      <td><StatusBadge status={r.status} /></td>
                      <td>{r.driver_id ? name.get(r.driver_id) : <span className="text-muted">Not assigned</span>}</td>
                      <td>{r.vehicle?.plate ?? <span className="text-muted">Not assigned</span>}</td>
                      <td>{formatTime(r.departure_at, ctx.tenant.time_zone)}</td>
                      <td>{done} of {r.route_stops.length}</td>
                      <td>{formatDistance(r.planned_distance_m)}</td>
                      <td>{formatDuration(r.planned_duration_s)}</td>
                      <td>{r.fuel_estimate_l ? formatLitres(Number(r.fuel_estimate_l)) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
