import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmSubmit, SubmitButton } from "@/components/buttons";
import { Card, Field, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { requireManager } from "@/lib/tenant";
import { linkCustomer, unlinkCustomer, updateLocation } from "../actions";
import { LocationPicker } from "../LocationPicker";

export const metadata: Metadata = { title: "Location" };
export const dynamic = "force-dynamic";

export default async function LocationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; error?: string }> }) {
  const ctx = await requireManager();
  const { id } = await params;
  const sp = await searchParams;
  const { data: loc } = await ctx.supabase.from("locations").select("*, customers(id, name, source)").eq("tenant_id", ctx.tenant.id).eq("id", id).maybeSingle();
  if (!loc) notFound();
  const { data: unlinked } = await ctx.supabase.from("customers").select("id, name").eq("tenant_id", ctx.tenant.id).is("location_id", null).order("name");
  const expires = loc.expires_at ? String(loc.expires_at).slice(0, 10) : "";

  return (
    <>
      <PageHeader title={loc.name} description={<span className="inline-flex items-center gap-2"><StatusBadge status={loc.status} /> Added {formatDateTime(loc.created_at, ctx.tenant.time_zone)}</span>} actions={<Link href="/locations?tab=all" className="btn-secondary">All locations</Link>} />
      {sp.notice && <div className="mb-4"><Notice tone="green">{sp.notice === "saved" ? "Changes saved." : sp.notice === "linked" ? "Customer linked." : "Customer unlinked."}</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="red">{sp.error}</Notice></div>}
      <div className="grid gap-5 xl:grid-cols-[1fr_400px] [&>*]:min-w-0">
        <Card title="Details">
          {ctx.isAdmin ? (
            <form action={updateLocation} className="space-y-4">
              <input type="hidden" name="id" value={loc.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="name"><input id="name" name="name" defaultValue={loc.name} className="input" required /></Field>
                <Field label="Type" htmlFor="type">
                  <select id="type" name="type" defaultValue={loc.type} className="input"><option value="shop">Shop</option><option value="depot">Depot</option><option value="fuel">Fuel</option><option value="hazard">Hazard</option></select>
                </Field>
              </div>
              <LocationPicker initial={[loc.lon, loc.lat]} height={320} />
              <Field label="Address" htmlFor="address"><input id="address" name="address" defaultValue={loc.address ?? ""} className="input" /></Field>
              <Field label="Directions for drivers" htmlFor="dirs"><textarea id="dirs" name="landmark_directions" defaultValue={loc.landmark_directions ?? ""} rows={3} className="input py-2" /></Field>
              {loc.type === "hazard" && <Field label="Expires" htmlFor="exp" hint="Leave empty for no expiry."><input id="exp" name="expires_at" type="date" defaultValue={expires} className="input" /></Field>}
              <SubmitButton>Save changes</SubmitButton>
            </form>
          ) : (
            <p className="text-muted">Only Owners and Admins can change locations.</p>
          )}
        </Card>
        <Card title="Customers delivered here">
          {loc.customers.length === 0 ? <p className="text-sm text-muted">No customers linked.</p> : (
            <ul className="divide-y divide-line">
              {(loc.customers as { id: string; name: string }[]).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                  <span>{c.name}</span>
                  {ctx.isAdmin && (
                    <form action={unlinkCustomer}>
                      <input type="hidden" name="locationId" value={loc.id} />
                      <input type="hidden" name="customerId" value={c.id} />
                      <ConfirmSubmit label="Unlink" title={`Unlink ${c.name}?`} message="Their invoices cannot be routed until they are linked to a location again." confirmLabel="Unlink" />
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {ctx.isAdmin && loc.status === "approved" && loc.type === "shop" && (
            <form action={linkCustomer} className="mt-4 space-y-3 border-t border-line pt-4">
              <input type="hidden" name="locationId" value={loc.id} />
              <Field label="Link a customer" htmlFor="customerId">
                <select id="customerId" name="customerId" className="input" required>
                  {(unlinked ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <SubmitButton className="btn-secondary">Link customer</SubmitButton>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
