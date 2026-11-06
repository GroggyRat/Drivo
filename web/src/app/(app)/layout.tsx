import { AppShell } from "@/components/AppShell";
import { requireManager } from "@/lib/tenant";
import { TenantSwitcher } from "./TenantSwitcher";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", dispatcher: "Dispatcher", driver: "Driver" } as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireManager();
  const options = ctx.memberships.filter((m) => m.role !== "driver").map((m) => ({ id: m.tenant_id, name: m.tenant.name }));
  return (
    <AppShell
      tenantName={ctx.tenant.name}
      userName={ctx.active.full_name}
      roleLabel={ROLE_LABEL[ctx.role]}
      tenantSwitcher={options.length > 1 ? <TenantSwitcher options={options} current={ctx.tenant.id} /> : null}
    >
      {children}
    </AppShell>
  );
}
