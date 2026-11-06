import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, Notice, PageHeader } from "@/components/ui";
import { requireManager } from "@/lib/tenant";
import { changeDeliveryPlace } from "../../actions";
import { PLACE_CHANGEABLE } from "../../place";
import { PlaceForm } from "./PlaceForm";

export const metadata: Metadata = { title: "Change delivery place" };
export const dynamic = "force-dynamic";

export default async function ChangePlacePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireManager();
  const { id } = await params;
  const { error } = await searchParams;
  const { data } = await ctx.supabase.from("orders")
    .select("id, reference, source, customer_name, delivery_status, customer:customers(id, name, location:locations(id, name, status))")
    .eq("id", id).eq("tenant_id", ctx.tenant.id).maybeSingle();
  if (!data) notFound();
  const order = data as unknown as { id: string; reference: string; source: string; customer_name: string; delivery_status: string; customer: { id: string; name: string; location: { id: string; name: string; status: string } | null } };
  const { data: places } = await ctx.supabase.from("locations").select("id, name, lon, lat")
    .eq("tenant_id", ctx.tenant.id).eq("type", "shop").eq("status", "approved").order("name");
  const { count: others } = order.source === "billzilla"
    ? await ctx.supabase.from("orders").select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenant.id).eq("customer_id", order.customer.id).neq("id", order.id).in("delivery_status", PLACE_CHANGEABLE)
    : { count: 0 };
  const current = order.customer.location?.status === "approved" ? order.customer.location : null;
  const canChange = PLACE_CHANGEABLE.includes(order.delivery_status);

  return (
    <>
      <PageHeader title={`Change delivery place: ${order.reference}`} description={`${order.customer_name}. Delivered to ${current ? current.name : "no place yet"}.`} />
      {error && <div className="mb-4"><Notice tone="red">{error}</Notice></div>}
      <div className="max-w-2xl space-y-4">
        {!canChange ? (
          <Notice tone="amber">This invoice is on a route or already finished, so its place cannot change here. If the route has not started, take the invoice off the route first.</Notice>
        ) : (
          <>
            {order.source === "billzilla" && (
              <Notice tone="blue">
                This is a BillZilla invoice, so Drivo changes the place for the customer {order.customer.name}.
                {others ? ` Their ${others} other invoice${others === 1 ? "" : "s"} waiting for delivery will go there too.` : ""}
              </Notice>
            )}
            <Card title="Delivery place">
              <PlaceForm
                action={changeDeliveryPlace.bind(null, order.id)}
                current={current?.id ?? null}
                places={(places ?? []).map((p) => ({ id: p.id, name: p.name, lon: Number(p.lon), lat: Number(p.lat) }))}
              />
            </Card>
          </>
        )}
      </div>
    </>
  );
}
