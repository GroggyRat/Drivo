"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformAdmin } from "@/lib/tenant";

const back = (path: string, params: Record<string, string>) => redirect(`${path}?${new URLSearchParams(params)}`);

/**
 * Creates the sign-in account for a company's Owner or Admin (server only;
 * the service role is used for this and nothing else here), or finds the
 * existing KaiTech account with that email. Returns a temporary password
 * only when a new account was made.
 */
async function ensureAccount(email: string, fullName: string) {
  const admin = createAdminClient();
  const password = randomBytes(9).toString("base64url");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (created.data.user) return { userId: created.data.user.id, password };
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const found = data?.users.find((u) => u.email?.toLowerCase() === email);
    if (found) return { userId: found.id, password: null };
    if (!data || data.users.length < 200) break;
  }
  throw new Error("Could not create the sign-in account");
}

const tenantSchema = z.object({
  name: z.string().trim().min(2, "Enter the company name").max(200),
  slug: z.string().trim().toLowerCase().regex(/^$|^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, "Web name: 3 to 40 lowercase letters, numbers and hyphens").optional(),
  time_zone: z.string().trim().min(1),
  contact_email: z.string().trim().toLowerCase().email("Enter a valid contact email").or(z.literal("")),
  owner_name: z.string().trim().min(1, "Enter the Owner's name").max(200),
  owner_email: z.string().trim().toLowerCase().email("Enter the Owner's email"),
});

export async function createTenant(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const parsed = tenantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) back("/platform/new", { error: parsed.error.issues[0].message });
  const d = parsed.data!;
  const { data: tenantId, error } = await ctx.supabase.rpc("platform_create_tenant", {
    p_name: d.name, p_slug: d.slug || null, p_time_zone: d.time_zone, p_contact_email: d.contact_email || d.owner_email,
  });
  if (error) back("/platform/new", { error: error.code === "23505" ? "That web name is taken. Choose another." : error.message });

  let account: { userId: string; password: string | null };
  try {
    account = await ensureAccount(d.owner_email, d.owner_name);
  } catch {
    back(`/platform/tenants/${tenantId}`, { error: "Company created, but the Owner's account could not be made. Add the Owner below." });
  }
  const { error: mErr } = await createAdminClient().from("memberships").insert({
    tenant_id: tenantId, user_id: account!.userId, role: "owner", full_name: d.owner_name, email: d.owner_email,
  });
  revalidatePath("/platform");
  if (mErr) back(`/platform/tenants/${tenantId}`, { error: "Company created, but the Owner could not be added. Add them below." });
  back(`/platform/tenants/${tenantId}`, account!.password
    ? { notice: "created", email: d.owner_email, password: account!.password }
    : { notice: "created-existing", email: d.owner_email });
}

export async function addPerson(formData: FormData) {
  await requirePlatformAdmin();
  const tenantId = String(formData.get("tenant_id"));
  const path = `/platform/tenants/${tenantId}`;
  const parsed = z.object({
    full_name: z.string().trim().min(1, "Enter a name").max(200),
    email: z.string().trim().toLowerCase().email("Enter a valid email"),
    role: z.enum(["owner", "admin"]),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) back(path, { error: parsed.error.issues[0].message });
  const d = parsed.data!;
  let account: { userId: string; password: string | null };
  try {
    account = await ensureAccount(d.email, d.full_name);
  } catch {
    back(path, { error: "Could not create the sign-in account" });
  }
  const { error } = await createAdminClient().from("memberships").insert({ tenant_id: tenantId, user_id: account!.userId, role: d.role, full_name: d.full_name, email: d.email });
  if (error) back(path, { error: error.code === "23505" ? (d.role === "owner" ? "This company already has an Owner, or this person is already in it." : "This person is already in the company.") : error.message });
  back(path, account!.password ? { notice: "added", email: d.email, password: account!.password } : { notice: "added-existing", email: d.email });
}

export async function setStatus(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const id = String(formData.get("tenant_id"));
  const { error } = await ctx.supabase.rpc("platform_set_tenant_status", { p_tenant_id: id, p_status: String(formData.get("status")) });
  revalidatePath("/platform");
  back(`/platform/tenants/${id}`, error ? { error: error.message } : { notice: String(formData.get("status")) });
}

export async function linkIntegrations(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const id = String(formData.get("tenant_id"));
  const { error } = await ctx.supabase.rpc("platform_link_tenant", {
    p_tenant_id: id,
    p_billzilla_org_id: String(formData.get("billzilla_org_id") ?? "").trim(),
    p_kaiworkforce_company_id: String(formData.get("kaiworkforce_company_id") ?? "").trim(),
  });
  revalidatePath("/platform");
  back(`/platform/tenants/${id}`, error ? { error: error.code === "23505" ? "That id is already linked to another company." : error.message } : { notice: "linked" });
}
