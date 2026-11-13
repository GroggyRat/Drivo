import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, StatCard, TableWrap } from "@/components/ui";
import { dueLabel, type BillingRow } from "@/lib/billing";
import { formatDate, formatMoney } from "@/lib/format";
import { requirePlatformAdmin } from "@/lib/tenant";

export const metadata: Metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const ctx = await requirePlatformAdmin();
  const { data, error } = await ctx.supabase.rpc("platform_billing");
  const rows = ((data ?? []) as BillingRow[]).map((r) => ({ ...r, monthly_fee: Number(r.monthly_fee), monthly_total: Number(r.monthly_total), amount_due: Number(r.amount_due) }));
  const overdue = rows.filter((r) => r.monthly_total > 0 && (r.days_until_due ?? 1) < 0);
  const soon = rows.filter((r) => r.monthly_total > 0 && r.days_until_due != null && r.days_until_due >= 0 && r.days_until_due <= 7);
  return (
    <>
      <PageHeader
        title="Payments"
        description="Every company on Drivo, with what it pays, when its next payment is due and what it owes now. Soonest due first. Drivo does not take the money: record each payment on the company's page when it arrives."
        actions={<Link href="/platform" className="btn-secondary">All companies</Link>}
      />
      {error && <p className="mb-4 text-bad">Could not load payments: {error.message}</p>}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Owed now" value={formatMoney(rows.reduce((s, r) => s + r.amount_due, 0))} detail="Due dates that have passed" tone={overdue.length ? "red" : undefined} />
        <StatCard label="Overdue" value={overdue.length} detail={overdue.length === 1 ? "company" : "companies"} tone={overdue.length ? "red" : undefined} />
        <StatCard label="Due in the next 7 days" value={soon.length} detail={formatMoney(soon.reduce((s, r) => s + r.monthly_total, 0))} />
        <StatCard label="Billed each month" value={formatMoney(rows.filter((r) => r.status === "active").reduce((s, r) => s + r.monthly_total, 0))} detail="Active companies, with add-ons" />
      </div>
      <Card bodyClassName="p-0">
        {rows.length === 0 ? (
          <EmptyState title="No companies yet" />
        ) : (
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Company</th><th scope="col">Each month</th><th scope="col">Next payment due</th>
                  <th scope="col">Status</th><th scope="col">Owed now</th><th scope="col">Last payment</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const due = dueLabel(r);
                  return (
                    <tr key={r.id}>
                      <td><Link className="link" href={`/platform/tenants/${r.id}`}>{r.name}</Link>{r.status === "suspended" && <p className="text-xs text-muted">Suspended</p>}</td>
                      <td>{formatMoney(r.monthly_total)}{r.road_alerts_enabled && <p className="text-xs text-muted">with road alerts</p>}</td>
                      <td>{r.next_due_on ? formatDate(r.next_due_on) : <span className="text-muted">Not set</span>}</td>
                      <td><Badge tone={due.tone} icon={due.tone === "green"}>{due.text}</Badge></td>
                      <td className={r.amount_due > 0 ? "font-semibold text-bad" : ""}>{formatMoney(r.amount_due)}{r.months_due > 1 && <p className="text-xs font-normal text-muted">{r.months_due} months</p>}</td>
                      <td>{r.last_paid_on ? <>{formatDate(r.last_paid_on)}<p className="text-xs text-muted">{formatMoney(r.last_paid_amount)}</p></> : <span className="text-muted">None yet</span>}</td>
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
