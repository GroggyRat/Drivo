import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "@/components/buttons";
import { IconSync } from "@/components/icons";
import { Badge, Card, EmptyState, Field, Notice, PageHeader, StatusBadge, TableWrap, Tabs } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { requireManager } from "@/lib/tenant";
import { addCustomer, addOrder, importOrders, syncFromBillzilla } from "./actions";

export const metadata: Metadata = { title: "Ready for delivery" };
export const dynamic = "force-dynamic";

type SP = Promise<{ tab?: string; notice?: string; count?: string; error?: string; problems?: string; mock?: string }>;

export default async function OrdersPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireManager();
  const sp = await searchParams;
  const tab = sp.tab ?? "ready";
  const { data } = await ctx.supabase
    .from("orders")
    .select("id, reference, source, customer_name, cartons, total_amount, currency, delivery_status, confirmed_at, created_at, customer:customers(id, location:locations(name, status))")
    .eq("tenant_id", ctx.tenant.id)
    .order("created_at", { ascending: false })
    .limit(500);
  type Row = { id: string; reference: string; source: string; customer_name: string; cartons: number; total_amount: string | null; currency: string; delivery_status: string; confirmed_at: string | null; created_at: string; customer: { id: string; location: { name: string; status: string } | null } | null };
  const rows = (data ?? []) as unknown as Row[];
  const located = (r: Row) => r.customer?.location?.status === "approved";
  const ready = rows.filter((r) => ["ready", "failed"].includes(r.delivery_status) && located(r));
  const needsPin = rows.filter((r) => ["ready", "failed"].includes(r.delivery_status) && !located(r));
  const list = tab === "needs-pin" ? needsPin : tab === "all" ? rows : ready;
  const { data: customers } = tab === "add"
    ? await ctx.supabase.from("customers").select("id, name, location_id").eq("tenant_id", ctx.tenant.id).eq("active", true).order("name")
    : { data: [] };

  return (
    <>
      <PageHeader
        title="Ready for delivery"
        description={ctx.tenant.billzilla_enabled ? "Confirmed BillZilla invoices arrive here automatically. Orders added in Drivo appear here too." : "Orders added in Drivo or imported from a spreadsheet."}
        actions={
          <>
            {ctx.tenant.billzilla_enabled && (
              <form action={syncFromBillzilla}><SubmitButton className="btn-secondary" pendingLabel="Syncing"><IconSync /> Sync from BillZilla</SubmitButton></form>
            )}
            <Link href="/plan" className="btn-primary">Plan route</Link>
          </>
        }
      />
      {sp.notice === "synced" && <div className="mb-4"><Notice tone="green">Checked BillZilla: {sp.count} confirmed invoice{sp.count === "1" ? "" : "s"} stored or updated.{sp.mock ? " (BillZilla is not connected yet; these are sample invoices.)" : ""}</Notice></div>}
      {sp.notice === "not-linked" && <div className="mb-4"><Notice tone="amber">This company is not linked to BillZilla. KaiTech links it on request.</Notice></div>}
      {sp.notice === "added" && <div className="mb-4"><Notice tone="green">Order added.</Notice></div>}
      {sp.notice === "imported" && <div className="mb-4"><Notice tone={sp.problems ? "amber" : "green"}>{sp.count} orders imported.{sp.problems ? ` Not imported: ${sp.problems}` : ""}</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="red">{sp.error}</Notice></div>}

      <Tabs
        current={tab}
        tabs={[
          { key: "ready", label: "Ready", href: "/orders", count: ready.length },
          { key: "needs-pin", label: "Needs a pin", href: "/orders?tab=needs-pin", count: needsPin.length },
          { key: "all", label: "All orders", href: "/orders?tab=all" },
          { key: "add", label: "Add order", href: "/orders?tab=add" },
          { key: "import", label: "Import CSV", href: "/orders?tab=import" },
        ]}
      />

      {tab === "add" ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Add an order">
            <form action={addOrder} className="space-y-4">
              <Field label="Customer" htmlFor="customerId" hint="Customers without a pin can be added, but not routed until they have one.">
                <select id="customerId" name="customerId" className="input" required>
                  {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.location_id ? "" : " (needs a pin)"}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Order number" htmlFor="reference"><input id="reference" name="reference" className="input" required /></Field>
                <Field label="Cartons" htmlFor="cartons"><input id="cartons" name="cartons" type="number" min={0} defaultValue={1} className="input" required /></Field>
              </div>
              <Field label="What to deliver" htmlFor="notes"><input id="notes" name="notes" className="input" placeholder="For example: 10 bags of rice" /></Field>
              <SubmitButton>Add order</SubmitButton>
            </form>
          </Card>
          <Card title="Add a customer">
            <form action={addCustomer} className="space-y-4">
              <Field label="Name" htmlFor="name"><input id="name" name="name" className="input" required /></Field>
              <Field label="Phone" htmlFor="phone"><input id="phone" name="phone" className="input" inputMode="tel" /></Field>
              <p className="text-sm text-muted">Link the customer to a location on the Locations page.</p>
              <SubmitButton className="btn-secondary">Add customer</SubmitButton>
            </form>
          </Card>
        </div>
      ) : tab === "import" ? (
        <Card title="Import orders from a spreadsheet">
          <form action={importOrders} className="space-y-4">
            <p className="text-sm text-muted">Save the spreadsheet as CSV with the columns <strong>reference</strong>, <strong>customer</strong> and <strong>cartons</strong>. New customer names are added without a location.</p>
            <Field label="CSV file" htmlFor="file"><input id="file" name="file" type="file" accept=".csv,text/csv" className="input py-2" required /></Field>
            <SubmitButton pendingLabel="Importing">Import orders</SubmitButton>
          </form>
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          {list.length === 0 ? (
            <EmptyState title={tab === "needs-pin" ? "Every customer has a location" : "Nothing here yet"} />
          ) : (
            <TableWrap>
              <table className="data-table">
                <thead><tr><th scope="col">Invoice or order</th><th scope="col">Customer</th><th scope="col">Cartons</th><th scope="col">Value</th><th scope="col">Received</th><th scope="col">From</th><th scope="col">Location</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td className="font-medium">{r.reference}</td>
                      <td>{r.customer_name}</td>
                      <td>{r.cartons}</td>
                      <td>{formatMoney(r.total_amount, r.currency)}</td>
                      <td>{formatDate(r.confirmed_at ?? r.created_at, ctx.tenant.time_zone)}</td>
                      <td>{r.source === "billzilla" ? "BillZilla" : r.source === "csv" ? "Import" : "Drivo"}</td>
                      <td>{located(r) ? <span>{r.customer?.location?.name}</span> : <Link href="/locations" className="no-underline"><Badge tone="amber" icon>Needs a pin</Badge></Link>}</td>
                      <td><StatusBadge status={r.delivery_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}
    </>
  );
}
