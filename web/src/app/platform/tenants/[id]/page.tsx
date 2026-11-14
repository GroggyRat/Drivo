import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmSubmit, SubmitButton } from "@/components/buttons";
import { Badge, Card, Field, Notice, PageHeader } from "@/components/ui";
import { formatDate, formatMoney, todayIn } from "@/lib/format";
import { dueLabel, type BillingRow } from "@/lib/billing";
import { requirePlatformAdmin } from "@/lib/tenant";
import { ROAD_ALERTS_PRICE } from "@/lib/road-alerts";
import { addPerson, resetAdminPassword, deleteTenant, linkIntegrations, recordPayment, setBilling, setRoadAlerts, setStatus } from "../../actions";

export const metadata: Metadata = { title: "Company" };
export const dynamic = "force-dynamic";

type TenantRow = {
  id: string; name: string; slug: string; status: "active" | "suspended"; created_at: string;
  billzilla_linked: boolean; kaiworkforce_linked: boolean; people: number; drivers: number; vehicles: number; routes_last_30_days: number; road_alerts_enabled: boolean;
};
type SP = Promise<{ notice?: string; error?: string; email?: string; password?: string }>;

const NOTICE: Record<string, string> = {
  "created-existing": "Company created. The Owner already has a KaiTech account and signs in with their own password.",
  "added-existing": "Added. They already have a KaiTech account and sign in with their own password.",
  suspended: "Suspended. Its people see nothing and cannot sign in to it. Nothing was deleted.",
  active: "Reactivated. Its people have access again.",
  linked: "Integration links saved.",
  "billing-saved": "Billing saved.",
  "payment-recorded": "Payment recorded. The next due date has moved on.",
  "road-alerts-on": `Road alerts turned on. ${ROAD_ALERTS_PRICE} is added to this company's billing.`,
  "road-alerts-off": "Road alerts turned off. Its drivers no longer see or send road alerts.",
};

export default async function TenantPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const ctx = await requirePlatformAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const { data } = await ctx.supabase.rpc("platform_list_tenants");
  const t = ((data ?? []) as TenantRow[]).find((x) => x.id === id);
  if (!t) notFound();
  const [{ data: billingRows }, { data: paymentRows }] = await Promise.all([
    ctx.supabase.rpc("platform_billing"),
    ctx.supabase.rpc("platform_tenant_payments", { p_tenant_id: id }),
  ]);
  const bill = ((billingRows ?? []) as BillingRow[]).find((b) => b.id === id) ?? null;
  const payments = (paymentRows ?? []) as { id: string; amount: number; paid_on: string; due_on: string | null; months: number; reference: string | null }[];
  const due = bill ? dueLabel(bill) : null;

  return (
    <>
      <PageHeader
        title={t.name}
        description={<span className="inline-flex flex-wrap items-center gap-2">{t.status === "active" ? <Badge tone="green" icon>Active</Badge> : <Badge tone="red" icon>Suspended</Badge>} Web name {t.slug}, since {formatDate(t.created_at)}</span>}
        actions={<Link href="/platform" className="btn-secondary">All companies</Link>}
      />
      {sp.password && (
        <div className="mb-4"><Notice tone="green">{sp.notice === "reset" ? "Password reset" : "Account created"} for {sp.email}. Temporary password: <strong className="select-all">{sp.password}</strong>. Give it to them in person. It is not shown again.</Notice></div>
      )}
      {sp.notice && !sp.password && NOTICE[sp.notice] && <div className="mb-4"><Notice tone={sp.notice === "suspended" ? "amber" : "green"}>{NOTICE[sp.notice]}</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="red">{sp.error}</Notice></div>}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[["People", t.people], ["Drivers", t.drivers], ["Vehicles", t.vehicles], ["Routes, last 30 days", t.routes_last_30_days]].map(([k, v]) => (
          <div key={k} className="card p-4"><p className="text-sm text-muted">{k}</p><p className="mt-1 text-2xl font-semibold">{v}</p></div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Card title="Add an Owner or Admin">
          <form action={addPerson} className="space-y-3">
            <input type="hidden" name="tenant_id" value={t.id} />
            <Field label="Full name" htmlFor="full_name"><input id="full_name" name="full_name" className="input" required /></Field>
            <Field label="Email" htmlFor="email"><input id="email" name="email" type="email" className="input" required /></Field>
            <Field label="Role" htmlFor="role" hint="A company has one Owner. Dispatchers and drivers are added by the company in Settings.">
              <select id="role" name="role" className="input" defaultValue="admin"><option value="admin">Admin</option><option value="owner">Owner</option></select>
            </Field>
            <SubmitButton pendingLabel="Adding">Add person</SubmitButton>
          </form>
        </Card>

        <Card title="Reset an Owner or Admin password">
          <form action={resetAdminPassword} className="space-y-3">
            <input type="hidden" name="tenant_id" value={t.id} />
            <p className="text-sm text-muted">For an Owner or Admin who cannot get the reset email. Their current password stops working and you get a temporary one to give them, shown once. The company resets its own dispatchers and drivers in Settings.</p>
            <Field label="Their email" htmlFor="reset_email"><input id="reset_email" name="email" type="email" className="input" autoComplete="off" required /></Field>
            <ConfirmSubmit label="Reset password" title="Reset this person's password?" message="Their current password stops working straight away." confirmLabel="Reset password" className="btn-secondary" />
          </form>
        </Card>

        <Card title="Integrations">
          <form action={linkIntegrations} className="space-y-3">
            <input type="hidden" name="tenant_id" value={t.id} />
            <p className="text-sm text-muted">Webhooks find the company by these ids, so only the platform can set them. Leave a field empty to unlink it.</p>
            <Field label="BillZilla organisation id" htmlFor="bz" hint={t.billzilla_linked ? "Linked now" : "Not linked"}><input id="bz" name="billzilla_org_id" className="input" /></Field>
            <Field label="KaiWorkforce company id" htmlFor="kw" hint={t.kaiworkforce_linked ? "Linked now" : "Not linked"}><input id="kw" name="kaiworkforce_company_id" className="input" /></Field>
            <SubmitButton className="btn-secondary">Save links</SubmitButton>
          </form>
        </Card>

        <Card title="Billing" actions={due && <Badge tone={due.tone} icon={due.tone === "green"}>{due.text}</Badge>}>
          {bill && (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">Each month</dt>
                <dd>{formatMoney(bill.monthly_total)}{bill.road_alerts_enabled ? ` (${formatMoney(bill.monthly_fee)} plus road alerts)` : ""}</dd>
                <dt className="text-muted">Next payment due</dt>
                <dd>{bill.next_due_on ? formatDate(bill.next_due_on) : "Not set"}</dd>
                <dt className="text-muted">Owed now</dt>
                <dd className={bill.amount_due > 0 ? "font-semibold text-bad" : ""}>{formatMoney(bill.amount_due)}{bill.months_due > 1 ? ` (${bill.months_due} months)` : ""}</dd>
              </dl>
              <form action={setBilling} className="mt-4 space-y-3 border-t border-line pt-4">
                <input type="hidden" name="tenant_id" value={t.id} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Monthly fee (FJD)" htmlFor="monthly_fee" hint="Without add-ons"><input id="monthly_fee" name="monthly_fee" className="input" inputMode="decimal" defaultValue={bill.monthly_fee} required /></Field>
                  <Field label="Next payment due" htmlFor="next_due_on"><input id="next_due_on" name="next_due_on" type="date" className="input" defaultValue={bill.next_due_on ?? ""} /></Field>
                </div>
                <SubmitButton className="btn-secondary">Save billing</SubmitButton>
              </form>
            </>
          )}
        </Card>

        <Card title="Payments">
          {bill?.next_due_on ? (
            <form action={recordPayment} className="space-y-3">
              <input type="hidden" name="tenant_id" value={t.id} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Amount paid (FJD)" htmlFor="amount"><input id="amount" name="amount" className="input" inputMode="decimal" defaultValue={bill.amount_due > 0 ? bill.amount_due : bill.monthly_total} required /></Field>
                <Field label="Paid on" htmlFor="paid_on"><input id="paid_on" name="paid_on" type="date" className="input" defaultValue={todayIn()} required /></Field>
                <Field label="Months covered" htmlFor="months"><input id="months" name="months" type="number" min={1} max={24} className="input" defaultValue={Math.max(1, bill.months_due)} required /></Field>
                <Field label="Reference" htmlFor="reference" hint="Optional"><input id="reference" name="reference" className="input" maxLength={200} /></Field>
              </div>
              <SubmitButton pendingLabel="Recording">Record payment</SubmitButton>
            </form>
          ) : (
            <p className="text-sm text-muted">Set the next due date under Billing before recording a payment.</p>
          )}
          {payments.length > 0 && (
            <ul className="mt-4 divide-y divide-line border-t border-line text-sm">
              {payments.map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span>{formatDate(p.paid_on)}<span className="text-muted">{p.due_on ? `, for ${formatDate(p.due_on)}` : ""}{p.months > 1 ? `, ${p.months} months` : ""}{p.reference ? `, ${p.reference}` : ""}</span></span>
                  <span className="font-medium tabular-nums">{formatMoney(p.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Add-ons">
          <form action={setRoadAlerts} className="space-y-3">
            <input type="hidden" name="tenant_id" value={t.id} />
            <input type="hidden" name="enabled" value={t.road_alerts_enabled ? "false" : "true"} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">Road alerts</p>
              <p className="flex items-center gap-2 text-sm">{ROAD_ALERTS_PRICE} {t.road_alerts_enabled ? <Badge tone="green" icon>On</Badge> : <Badge tone="grey">Off</Badge>}</p>
            </div>
            <p className="text-sm text-muted">Drivers report hazards, police checkpoints and speed cameras, and are warned as they come near one. Reports stay inside the company. The price is added to the company&apos;s monthly billing.</p>
            {t.road_alerts_enabled ? (
              <ConfirmSubmit label="Turn off road alerts" title={`Turn off road alerts for ${t.name}?`} message="Its drivers will no longer see or send road alerts. Reports already made are kept but hidden." confirmLabel="Turn off" className="btn-secondary" />
            ) : (
              <SubmitButton pendingLabel="Turning on">Turn on road alerts</SubmitButton>
            )}
          </form>
        </Card>

        <Card title="Access">
          <form action={setStatus} className="space-y-3">
            <input type="hidden" name="tenant_id" value={t.id} />
            {t.status === "active" ? (
              <>
                <input type="hidden" name="status" value="suspended" />
                <p className="text-sm text-muted">Suspending hides all of the company&apos;s data from its people and stops tracking uploads. Nothing is deleted; you can reactivate at any time.</p>
                <ConfirmSubmit label="Suspend company" title={`Suspend ${t.name}?`} message="Its people will see nothing until you reactivate it. No data is deleted." confirmLabel="Suspend" className="btn-danger" />
              </>
            ) : (
              <>
                <input type="hidden" name="status" value="active" />
                <SubmitButton>Reactivate company</SubmitButton>
              </>
            )}
          </form>
          <div className="mt-4 border-t border-line pt-4">
            <p className="font-medium">Delete company</p>
            {t.status === "active" ? (
              <p className="mt-1 text-sm text-muted">Suspend the company first. Deleting is only offered for a suspended company.</p>
            ) : (
              <form action={deleteTenant} className="mt-2 space-y-3">
                <input type="hidden" name="tenant_id" value={t.id} />
                <p className="text-sm text-muted">Removes the company and all of its routes, deliveries, locations, proofs, tracking and payment records for good. It cannot be undone. Its people keep their KaiTech sign-in accounts.</p>
                <Field label={`Type the web name, ${t.slug}, to confirm`} htmlFor="confirm_slug"><input id="confirm_slug" name="confirm_slug" className="input" autoComplete="off" required /></Field>
                <ConfirmSubmit label="Delete company" title={`Delete ${t.name} for good?`} message="Every record of this company is removed and cannot be brought back. Export anything you need first." confirmLabel="Delete for good" className="btn-danger" />
              </form>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
