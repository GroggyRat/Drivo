import type { Metadata } from "next";
import Link from "next/link";
import { IconDownload } from "@/components/icons";
import { Card, EmptyState, PageHeader, StatCard, StatusBadge, TableWrap } from "@/components/ui";
import { dayTotals, loadDeliveries } from "@/lib/deliveries";
import { formatDate, formatDateTime, formatSpeed, formatTime, todayIn } from "@/lib/format";
import { requireManager } from "@/lib/tenant";
import { LegMap } from "./LegMap";

export const metadata: Metadata = { title: "Deliveries" };
export const dynamic = "force-dynamic";

type SP = Promise<{ date?: string; driver?: string; status?: string; q?: string; stop?: string }>;

export default async function DeliveriesPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireManager();
  const sp = await searchParams;
  const tz = ctx.tenant.time_zone;
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIn(tz);
  const filters = { date, driver: sp.driver || undefined, status: sp.status || undefined, q: sp.q || undefined };
  const [rows, { data: people }] = await Promise.all([
    loadDeliveries(ctx.supabase, ctx.tenant.id, filters),
    ctx.supabase.from("memberships").select("user_id, full_name, role").eq("tenant_id", ctx.tenant.id),
  ]);
  const name = new Map((people ?? []).map((p) => [p.user_id, p.full_name]));
  const totals = dayTotals(rows);
  const qs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    Object.entries({ date, driver: sp.driver, status: sp.status, q: sp.q, ...extra }).forEach(([k, v]) => v && p.set(k, v));
    return p.toString();
  };

  // Detail panel for one stop.
  const selected = sp.stop ? rows.find((r) => r.id === sp.stop) : undefined;
  let detail: null | {
    photoUrl: string | null; signatureUrl: string | null; topSpeed: number | null; legFrom: [number, number] | null; legFromName: string; routeLine: [number, number][];
  } = null;
  if (selected) {
    const sign = async (path: string | null | undefined) =>
      path ? (await ctx.supabase.storage.from("delivery-proofs").createSignedUrl(path, 600)).data?.signedUrl ?? null : null;
    const { data: route } = await ctx.supabase
      .from("routes")
      .select("geometry_geojson, started_at, depot:depots(name, lon, lat), route_stops(sequence, completed_at, location:locations(name, lon, lat))")
      .eq("id", selected.route.id)
      .single();
    type RS = { sequence: number; completed_at: string | null; location: { name: string; lon: number; lat: number } };
    const prev = ((route?.route_stops ?? []) as unknown as RS[]).find((s) => s.sequence === selected.sequence - 1);
    const depot = route?.depot as unknown as { name: string; lon: number; lat: number } | null;
    const legStart = prev?.completed_at ?? route?.started_at ?? null;
    let topSpeed: number | null = null;
    if (selected.route.driver_id && legStart && selected.completed_at) {
      const { data: ev } = await ctx.supabase
        .from("speed_events")
        .select("max_speed_kmh")
        .eq("tenant_id", ctx.tenant.id)
        .eq("driver_id", selected.route.driver_id)
        .gte("started_at", legStart)
        .lte("started_at", selected.completed_at)
        .order("max_speed_kmh", { ascending: false })
        .limit(1);
      topSpeed = ev?.[0] ? Number(ev[0].max_speed_kmh) : null;
    }
    detail = {
      photoUrl: await sign(selected.proof?.photo_path),
      signatureUrl: await sign(selected.proof?.signature_path),
      topSpeed,
      legFrom: prev ? [prev.location.lon, prev.location.lat] : depot ? [depot.lon, depot.lat] : null,
      legFromName: prev ? prev.location.name : depot?.name ?? "Depot",
      routeLine: (route?.geometry_geojson as { coordinates: [number, number][] } | null)?.coordinates ?? [],
    };
  }
  const billzillaUrl = process.env.NEXT_PUBLIC_BILLZILLA_URL;

  return (
    <>
      <PageHeader
        title="Deliveries"
        description={`Every stop on ${formatDate(date)}`}
        actions={<a className="btn-secondary" href={`/api/deliveries/export?${qs({ stop: undefined })}`}><IconDownload /> Export CSV</a>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Stops" value={totals.stops} />
        <StatCard label="Delivered" value={totals.delivered} />
        <StatCard label="Part delivered" value={totals.partial} />
        <StatCard label="Not delivered" value={totals.failed} tone={totals.failed ? "red" : undefined} />
        <StatCard label="Still to do" value={totals.waiting} />
        <StatCard label="Cartons delivered" value={totals.cartons} />
      </div>

      <form className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <div><label htmlFor="date" className="field-label">Date</label><input id="date" name="date" type="date" defaultValue={date} className="input" /></div>
        <div>
          <label htmlFor="driver" className="field-label">Driver</label>
          <select id="driver" name="driver" defaultValue={sp.driver ?? ""} className="input">
            <option value="">All drivers</option>
            {(people ?? []).filter((p) => p.role === "driver").map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="status" className="field-label">Status</label>
          <select id="status" name="status" defaultValue={sp.status ?? ""} className="input">
            <option value="">All</option><option value="delivered">Delivered</option><option value="partially_delivered">Part delivered</option>
            <option value="failed">Not delivered</option><option value="scheduled">Scheduled</option><option value="arrived">Arrived</option>
          </select>
        </div>
        <div><label htmlFor="q" className="field-label">Invoice or customer</label><input id="q" name="q" defaultValue={sp.q} className="input" /></div>
        <button className="btn-secondary" type="submit">Show</button>
      </form>

      <div className={`grid gap-5 ${selected ? "xl:grid-cols-[1fr_460px]" : ""}`}>
        <Card bodyClassName="p-0">
          {rows.length === 0 ? <EmptyState title="No deliveries match" /> : (
            <TableWrap>
              <table className="data-table">
                <thead><tr><th scope="col">Time</th><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Driver</th><th scope="col">Status</th><th scope="col">Proof</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={r.id === selected?.id ? "bg-info-bg/40" : undefined}>
                      <td>{formatTime(r.completed_at ?? r.planned_eta, tz)}</td>
                      <td><Link className="link" href={`/deliveries?${qs({ stop: r.id })}`}>{r.order?.reference ?? "No invoice"}</Link></td>
                      <td>{r.order?.customer_name ?? r.location.name}</td>
                      <td>{r.route.driver_id ? name.get(r.route.driver_id) : ""}<p className="text-xs text-muted">{r.route.vehicle?.plate}</p></td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="text-sm">{r.proof ? [r.proof.photo_path && "Photo", r.proof.signature_path && "Signature"].filter(Boolean).join(", ") || "Recorded" : <span className="text-muted">None</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        {selected && detail && (
          <Card title={`${selected.order?.reference ?? "Stop"}, ${selected.order?.customer_name ?? selected.location.name}`} actions={<Link className="btn-secondary btn-sm" href={`/deliveries?${qs({ stop: undefined })}`}>Close</Link>}>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2"><StatusBadge status={selected.status} />{selected.order?.cartons != null && <span className="text-sm text-muted">{selected.order.cartons} cartons</span>}</div>
              <LegMap from={detail.legFrom} fromName={detail.legFromName} to={[selected.location.lon, selected.location.lat]} toName={selected.location.name} routeLine={detail.routeLine} />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted">Planned arrival</dt><dd>{formatTime(selected.planned_eta, tz)}</dd>
                <dt className="text-muted">Arrived</dt><dd>{formatTime(selected.arrived_at, tz) || "Not recorded"}</dd>
                <dt className="text-muted">Completed</dt><dd>{formatDateTime(selected.completed_at, tz) || "Not yet"}</dd>
                <dt className="text-muted">Top speed on this leg</dt><dd>{detail.topSpeed != null ? <span className="font-semibold text-bad">{formatSpeed(detail.topSpeed)} (speed alert)</span> : "Within limits"}</dd>
                <dt className="text-muted">Received by</dt><dd>{selected.proof?.received_by ?? ""}</dd>
                <dt className="text-muted">Delivered in full</dt><dd>{selected.proof ? (selected.proof.delivered_in_full ? "Yes" : "No") : ""}</dd>
              </dl>
              {(selected.proof?.partial_notes || selected.failure_reason) && (
                <p className="rounded-[var(--radius-control)] bg-warn-bg px-3 py-2 text-sm text-warn">{selected.proof?.partial_notes ?? selected.failure_reason}</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <figure>
                  <figcaption className="mb-1 text-xs text-muted">Photo</figcaption>
                  {detail.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={detail.photoUrl} alt="Proof of delivery photo" className="h-36 w-full rounded-[var(--radius-control)] border border-line object-cover" />
                  ) : <div className="flex h-36 items-center justify-center rounded-[var(--radius-control)] border border-dashed border-line text-sm text-muted">None</div>}
                </figure>
                <figure>
                  <figcaption className="mb-1 text-xs text-muted">Signature</figcaption>
                  {detail.signatureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={detail.signatureUrl} alt="Customer signature" className="h-36 w-full rounded-[var(--radius-control)] border border-line bg-white object-contain" />
                  ) : <div className="flex h-36 items-center justify-center rounded-[var(--radius-control)] border border-dashed border-line text-sm text-muted">None</div>}
                </figure>
              </div>
              {selected.order?.billzilla_invoice_id && (
                billzillaUrl ? (
                  <a className="btn-secondary" href={`${billzillaUrl.replace(/\/$/, "")}/invoices/${encodeURIComponent(selected.order.billzilla_invoice_id)}`} target="_blank" rel="noreferrer">Open invoice in BillZilla</a>
                ) : (
                  <p className="text-sm text-muted">BillZilla invoice {selected.order.billzilla_invoice_id}</p>
                )
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
