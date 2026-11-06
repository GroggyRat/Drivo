import { toCsv } from "@/lib/csv";
import { loadDeliveries } from "@/lib/deliveries";
import { formatDateTime, statusLabel, todayIn } from "@/lib/format";
import { getContext } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ctx = await getContext();
  if (!ctx.isManager || !ctx.tenant) return new Response("Not allowed", { status: 403 });
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? todayIn(ctx.tenant.time_zone);
  const rows = await loadDeliveries(ctx.supabase, ctx.tenant.id, {
    date,
    driver: url.searchParams.get("driver") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  const { data: people } = await ctx.supabase.from("memberships").select("user_id, full_name").eq("tenant_id", ctx.tenant.id);
  const name = new Map((people ?? []).map((p) => [p.user_id, p.full_name]));
  const tz = ctx.tenant.time_zone;
  const csv = toCsv(
    ["Date", "Route", "Stop", "Invoice", "BillZilla invoice id", "Customer", "Location", "Driver", "Vehicle", "Cartons", "Status", "Planned", "Arrived", "Completed", "Received by", "Delivered in full", "Notes", "Photo", "Signature"],
    rows.map((r) => [
      date, r.route.name, r.sequence, r.order?.reference, r.order?.billzilla_invoice_id, r.order?.customer_name, r.location.name,
      r.route.driver_id ? name.get(r.route.driver_id) : "", r.route.vehicle?.plate, r.order?.cartons, statusLabel(r.status),
      formatDateTime(r.planned_eta, tz), formatDateTime(r.arrived_at, tz), formatDateTime(r.completed_at, tz),
      r.proof?.received_by, r.proof ? (r.proof.delivered_in_full ? "Yes" : "No") : "", r.proof?.partial_notes ?? r.failure_reason,
      r.proof?.photo_path ? "Yes" : "No", r.proof?.signature_path ? "Yes" : "No",
    ]),
  );
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="drivo-deliveries-${date}.csv"` },
  });
}
