import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Role = "owner" | "admin" | "dispatcher" | "driver";

export type Tenant = {
  id: string;
  name: string;
  slug: string;
  time_zone: string;
  billzilla_enabled: boolean;
  kaiworkforce_enabled: boolean;
  billzilla_org_id: string | null;
  kaiworkforce_company_id: string | null;
  logo_path: string | null;
  /** The road alerts add-on, turned on by the platform. */
  road_alerts_enabled: boolean;
};

export type Membership = { tenant_id: string; role: Role; full_name: string; tenant: Tenant };

export const TENANT_COOKIE = "drivo_tenant";

/**
 * The signed-in person and the tenant they are working in. RLS already
 * limits every query to the person's tenants; the active tenant only picks
 * which one the pages show.
 */
export async function getContext() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub as string | undefined;
  if (!userId) redirect("/sign-in");

  const { data } = await supabase
    .from("memberships")
    .select("tenant_id, role, full_name, tenant:tenants(id, name, slug, time_zone, billzilla_enabled, kaiworkforce_enabled, billzilla_org_id, kaiworkforce_company_id, logo_path, road_alerts_enabled)")
    .eq("user_id", userId)
    .eq("active", true)
    .order("created_at");
  const memberships = ((data ?? []) as unknown as Membership[]).filter((m) => m.tenant);

  // KaiTech platform owners: they manage tenants in /platform and see no tenant data.
  const { data: platformRow } = await supabase.from("platform_admins").select("user_id, full_name").eq("user_id", userId).maybeSingle();

  const cookieStore = await cookies();
  const wanted = cookieStore.get(TENANT_COOKIE)?.value;
  const active =
    memberships.find((m) => m.tenant_id === wanted && m.role !== "driver") ??
    memberships.find((m) => m.role !== "driver") ??
    null;

  return {
    supabase,
    userId,
    memberships,
    active,
    tenant: active?.tenant ?? null,
    role: active?.role ?? null,
    isAdmin: active?.role === "owner" || active?.role === "admin",
    isManager: !!active && active.role !== "driver",
    isPlatformAdmin: !!platformRow,
    platformName: (platformRow?.full_name as string | undefined) ?? null,
  };
}

export type Context = Awaited<ReturnType<typeof getContext>>;
export type ManagerContext = Context & { tenant: Tenant; role: Role; active: Membership };

/** For pages for Owners, Admins and Dispatchers. */
export async function requireManager(): Promise<ManagerContext> {
  const ctx = await getContext();
  if (!ctx.isManager || !ctx.tenant) {
    if (ctx.isPlatformAdmin) redirect("/platform");
    // Drivers use the app on their phone, or the driver page in the browser.
    redirect(ctx.memberships.some((m) => m.role === "driver") ? "/driver" : "/no-access");
  }
  return ctx as ManagerContext;
}

/** For settings and approvals: Owners and Admins. */
export async function requireAdmin(): Promise<ManagerContext> {
  const ctx = await requireManager();
  if (!ctx.isAdmin) redirect("/?notice=admins-only");
  return ctx;
}

/** For the KaiTech platform console. */
export async function requirePlatformAdmin() {
  const ctx = await getContext();
  if (!ctx.isPlatformAdmin) redirect(ctx.isManager ? "/" : "/no-access");
  return ctx;
}
