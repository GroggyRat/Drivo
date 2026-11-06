import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmSubmit, SubmitButton } from "@/components/buttons";
import { Badge, Card, Field, Notice, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { requirePlatformAdmin } from "@/lib/tenant";
import { addPerson, linkIntegrations, setStatus } from "../../actions";

export const metadata: Metadata = { title: "Company" };
export const dynamic = "force-dynamic";

type TenantRow = {
  id: string; name: string; slug: string; status: "active" | "suspended"; created_at: string;
  billzilla_linked: boolean; kaiworkforce_linked: boolean; people: number; drivers: number; vehicles: number; routes_last_30_days: number;
};
type SP = Promise<{ notice?: string; error?: string; email?: string; password?: string }>;

const NOTICE: Record<string, string> = {
  "created-existing": "Company created. The Owner already has a KaiTech account and signs in with their own password.",
  "added-existing": "Added. They already have a KaiTech account and sign in with their own password.",
  suspended: "Suspended. Its people see nothing and cannot sign in to it. Nothing was deleted.",
  active: "Reactivated. Its people have access again.",
  linked: "Integration links saved.",
};

export default async function TenantPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const ctx = await requirePlatformAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const { data } = await ctx.supabase.rpc("platform_list_tenants");
  const t = ((data ?? []) as TenantRow[]).find((x) => x.id === id);
  if (!t) notFound();

  return (
    <>
      <PageHeader
        title={t.name}
        description={<span className="inline-flex flex-wrap items-center gap-2">{t.status === "active" ? <Badge tone="green" icon>Active</Badge> : <Badge tone="red" icon>Suspended</Badge>} Web name {t.slug}, since {formatDate(t.created_at)}</span>}
        actions={<Link href="/platform" className="btn-secondary">All companies</Link>}
      />
      {sp.password && (
        <div className="mb-4"><Notice tone="green">Account created for {sp.email}. Temporary password: <strong className="select-all">{sp.password}</strong>. Give it to them in person. It is not shown again.</Notice></div>
      )}
      {sp.notice && !sp.password && NOTICE[sp.notice] && <div className="mb-4"><Notice tone={sp.notice === "suspended" ? "amber" : "green"}>{NOTICE[sp.notice]}</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="red">{sp.error}</Notice></div>}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[["People", t.people], ["Drivers", t.drivers], ["Vehicles", t.vehicles], ["Routes, last 30 days", t.routes_last_30_days]].map(([k, v]) => (
          <div key={k} className="card p-4"><p className="text-sm text-muted">{k}</p><p className="mt-1 text-2xl font-semibold">{v}</p></div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
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

        <Card title="Integrations">
          <form action={linkIntegrations} className="space-y-3">
            <input type="hidden" name="tenant_id" value={t.id} />
            <p className="text-sm text-muted">Webhooks find the company by these ids, so only the platform can set them. Leave a field empty to unlink it.</p>
            <Field label="BillZilla organisation id" htmlFor="bz" hint={t.billzilla_linked ? "Linked now" : "Not linked"}><input id="bz" name="billzilla_org_id" className="input" /></Field>
            <Field label="KaiWorkforce company id" htmlFor="kw" hint={t.kaiworkforce_linked ? "Linked now" : "Not linked"}><input id="kw" name="kaiworkforce_company_id" className="input" /></Field>
            <SubmitButton className="btn-secondary">Save links</SubmitButton>
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
        </Card>
      </div>
    </>
  );
}
