import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { todayIn } from "@/lib/format";
import { requireManager } from "@/lib/tenant";
import { loadPlanningLists } from "./data";
import { PlanFlow, type PlanOrder } from "./PlanFlow";

export const metadata: Metadata = { title: "Plan route" };
export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const ctx = await requireManager();
  const [{ data: orders }, lists] = await Promise.all([
    ctx.supabase
      .from("orders")
      .select("id, reference, source, customer_name, cartons, total_amount, currency, delivery_status, confirmed_at, customer:customers(id, location:locations(id, name, status))")
      .eq("tenant_id", ctx.tenant.id)
      .in("delivery_status", ["ready", "failed"])
      .order("confirmed_at", { ascending: true, nullsFirst: false }),
    loadPlanningLists(ctx),
  ]);
  type Row = { id: string; reference: string; source: string; customer_name: string; cartons: number; total_amount: string | null; currency: string; delivery_status: string; confirmed_at: string | null; customer: { id: string; location: { id: string; name: string; status: string } | null } | null };
  const planOrders: PlanOrder[] = ((orders ?? []) as unknown as Row[]).map((o) => ({
    id: o.id,
    reference: o.reference,
    source: o.source,
    customer: o.customer_name,
    cartons: o.cartons,
    total: o.total_amount,
    currency: o.currency,
    status: o.delivery_status,
    confirmedAt: o.confirmed_at,
    located: o.customer?.location?.status === "approved",
    locationName: o.customer?.location?.name ?? null,
  }));

  return (
    <>
      <PageHeader
        title="Plan route"
        description="Choose invoices, compare three route options, then assign a driver and vehicle."
        actions={!ctx.tenant.billzilla_enabled && <Link href="/orders?tab=add" className="btn-secondary">Add delivery</Link>}
      />
      <PlanFlow
        orders={planOrders}
        depots={lists.depots}
        vehicles={lists.vehicles}
        drivers={lists.drivers}
        tomorrow={todayIn(ctx.tenant.time_zone, 1)}
        today={todayIn(ctx.tenant.time_zone)}
        timeZone={ctx.tenant.time_zone}
        billzilla={ctx.tenant.billzilla_enabled}
      />
    </>
  );
}
