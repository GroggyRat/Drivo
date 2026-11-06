import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DeliveryFilters = { date: string; driver?: string; status?: string; q?: string };

export type DeliveryRow = {
  id: string;
  sequence: number;
  status: string;
  planned_eta: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  route: { id: string; name: string | null; route_date: string; driver_id: string | null; vehicle: { plate: string } | null };
  location: { id: string; name: string; lon: number; lat: number };
  order: { id: string; reference: string; customer_name: string; cartons: number; source: string; billzilla_invoice_id: string | null; total_amount: string | null; currency: string } | null;
  proof: { received_by: string | null; delivered_in_full: boolean; partial_notes: string | null; photo_path: string | null; signature_path: string | null; captured_at: string } | null;
};

export async function loadDeliveries(supabase: SupabaseClient, tenantId: string, f: DeliveryFilters) {
  let query = supabase
    .from("route_stops")
    .select(
      "id, sequence, status, planned_eta, arrived_at, completed_at, failure_reason, route:routes!inner(id, name, route_date, driver_id, status, vehicle:vehicles(plate)), location:locations(id, name, lon, lat), order:orders(id, reference, customer_name, cartons, source, billzilla_invoice_id, total_amount, currency), proof:proofs_of_delivery(received_by, delivered_in_full, partial_notes, photo_path, signature_path, captured_at)",
    )
    .eq("tenant_id", tenantId)
    .eq("route.route_date", f.date)
    .neq("route.status", "draft")
    .order("completed_at", { ascending: true, nullsFirst: false });
  if (f.driver) query = query.eq("route.driver_id", f.driver);
  if (f.status) query = query.eq("status", f.status);
  const { data, error } = await query;
  if (error) throw error;
  let rows = ((data ?? []) as unknown as (Omit<DeliveryRow, "proof"> & { proof: DeliveryRow["proof"] | DeliveryRow["proof"][] })[]).map((r) => ({
    ...r,
    proof: Array.isArray(r.proof) ? r.proof[0] ?? null : r.proof,
  })) as DeliveryRow[];
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((r) => [r.order?.reference, r.order?.customer_name, r.location.name].some((v) => v?.toLowerCase().includes(q)));
  }
  return rows;
}

export function dayTotals(rows: DeliveryRow[]) {
  const by = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    stops: rows.length,
    delivered: by("delivered"),
    partial: by("partially_delivered"),
    failed: by("failed"),
    waiting: rows.filter((r) => ["scheduled", "arrived"].includes(r.status)).length,
    cartons: rows.filter((r) => r.status === "delivered" || r.status === "partially_delivered").reduce((s, r) => s + (r.order?.cartons ?? 0), 0),
  };
}
