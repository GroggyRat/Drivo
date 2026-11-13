import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, StatCard, TableWrap } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { requirePlatformAdmin } from "@/lib/tenant";

export const dynamic = "force-dynamic";

type TenantRow = {
  id: string; name: string; slug: string; status: "active" | "suspended"; created_at: string;
  billzilla_linked: boolean; kaiworkforce_linked: boolean; people: number; drivers: number; vehicles: number; routes_last_30_days: number; road_alerts_enabled: boolean;
};

export default async function PlatformPage() {
  const ctx = await requirePlatformAdmin();
  const { data, error } = await ctx.supabase.rpc("platform_list_tenants");
  const tenants = (data ?? []) as TenantRow[];
  const active = tenants.filter((t) => t.status === "active");
  return (
    <>
      <PageHeader
        title="Companies"
        description="Every company using Drivo. You see counts only, never a company's routes, deliveries or locations."
        actions={<Link href="/platform/new" className="btn-primary">New company</Link>}
      />
      {error && <p className="mb-4 text-bad">Could not load companies: {error.message}</p>}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Active companies" value={active.length} detail={`${tenants.length - active.length} suspended`} />
        <StatCard label="People" value={tenants.reduce((s, t) => s + t.people, 0)} />
        <StatCard label="Drivers" value={tenants.reduce((s, t) => s + t.drivers, 0)} />
        <StatCard label="Routes, last 30 days" value={tenants.reduce((s, t) => s + t.routes_last_30_days, 0)} />
      </div>
      <Card bodyClassName="p-0">
        {tenants.length === 0 ? (
          <EmptyState title="No companies yet"><Link className="link" href="/platform/new">Add the first company</Link> and its Owner.</EmptyState>
        ) : (
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Company</th><th scope="col">Status</th><th scope="col">People</th><th scope="col">Drivers</th>
                  <th scope="col">Vehicles</th><th scope="col">Routes, 30 days</th><th scope="col">Integrations</th><th scope="col">Add-ons</th><th scope="col">Since</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id}>
                    <td><Link className="link" href={`/platform/tenants/${t.id}`}>{t.name}</Link><p className="text-xs text-muted">{t.slug}</p></td>
                    <td>{t.status === "active" ? <Badge tone="green" icon>Active</Badge> : <Badge tone="red" icon>Suspended</Badge>}</td>
                    <td>{t.people}</td><td>{t.drivers}</td><td>{t.vehicles}</td><td>{t.routes_last_30_days}</td>
                    <td className="text-sm">{[t.billzilla_linked && "BillZilla", t.kaiworkforce_linked && "KaiWorkforce"].filter(Boolean).join(", ") || <span className="text-muted">None</span>}</td>
                    <td className="text-sm">{t.road_alerts_enabled ? "Road alerts" : <span className="text-muted">None</span>}</td>
                    <td>{formatDate(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
