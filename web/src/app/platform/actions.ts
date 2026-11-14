"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { emailedParam, sendSignInEmail } from "@/lib/email";
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

/** The company's name, for the email to its new or reset Owner or Admin. */
async function companyName(tenantId: string): Promise<string | null> {
  const { data } = await createAdminClient().from("tenants").select("name").eq("id", tenantId).maybeSingle();
  return (data?.name as string | undefined) ?? null;
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
  if (!account!.password) back(`/platform/tenants/${tenantId}`, { notice: "created-existing", email: d.owner_email });
  const sent = await sendSignInEmail({ kind: "created", name: d.owner_name, companyName: d.name, email: d.owner_email, password: account!.password! });
  back(`/platform/tenants/${tenantId}`, { notice: "created", email: d.owner_email, password: account!.password!, ...emailedParam(sent) });
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
  if (!account!.password) back(path, { notice: "added-existing", email: d.email });
  const sent = await sendSignInEmail({ kind: "created", name: d.full_name, companyName: await companyName(tenantId), email: d.email, password: account!.password! });
  back(path, { notice: "added", email: d.email, password: account!.password!, ...emailedParam(sent) });
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

/** The road alerts add-on for a company. */
export async function setRoadAlerts(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const id = String(formData.get("tenant_id"));
  const on = formData.get("enabled") === "true";
  const { error } = await ctx.supabase.rpc("platform_set_road_alerts", { p_tenant_id: id, p_enabled: on });
  revalidatePath("/platform");
  back(`/platform/tenants/${id}`, error ? { error: error.message } : { notice: on ? "road-alerts-on" : "road-alerts-off" });
}

/** A company's monthly fee and the date its next payment is due. */
export async function setBilling(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const id = String(formData.get("tenant_id"));
  const path = `/platform/tenants/${id}`;
  const parsed = z.object({
    monthly_fee: z.coerce.number({ message: "Enter the monthly fee" }).min(0, "Enter a monthly fee of 0 or more").max(99999),
    next_due_on: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/, "Choose the next due date"),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) back(path, { error: parsed.error.issues[0].message });
  const { error } = await ctx.supabase.rpc("platform_set_billing", {
    p_tenant_id: id, p_monthly_fee: parsed.data!.monthly_fee, p_next_due_on: parsed.data!.next_due_on || null,
  });
  revalidatePath("/platform");
  back(path, error ? { error: error.message } : { notice: "billing-saved" });
}

/** Record a payment received from a company. The next due date moves on by the months paid. */
export async function recordPayment(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const id = String(formData.get("tenant_id"));
  const path = `/platform/tenants/${id}`;
  const parsed = z.object({
    amount: z.coerce.number({ message: "Enter the amount paid" }).min(0, "Enter the amount paid").max(999999),
    paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date it was paid"),
    months: z.coerce.number().int().min(1, "Months must be 1 to 24").max(24, "Months must be 1 to 24"),
    reference: z.string().trim().max(200).optional(),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) back(path, { error: parsed.error.issues[0].message });
  const d = parsed.data!;
  const { error } = await ctx.supabase.rpc("platform_record_payment", {
    p_tenant_id: id, p_amount: d.amount, p_paid_on: d.paid_on, p_months: d.months, p_reference: d.reference || null,
  });
  revalidatePath("/platform");
  back(path, error ? { error: error.message } : { notice: "payment-recorded" });
}

const TENANT_BUCKETS = ["location-photos", "delivery-proofs", "invoices"];

/** Removes every file under a folder of a private bucket (file paths start with the company's id). */
async function removeFolder(admin: ReturnType<typeof createAdminClient>, bucket: string, folder: string, depth = 0): Promise<void> {
  if (depth > 6) return;
  for (let round = 0; round < 200; round++) {
    const { data } = await admin.storage.from(bucket).list(folder, { limit: 1000 });
    if (!data?.length) return;
    const files = data.filter((e) => e.id).map((e) => `${folder}/${e.name}`);
    for (const dir of data.filter((e) => !e.id)) await removeFolder(admin, bucket, `${folder}/${dir.name}`, depth + 1);
    if (files.length) await admin.storage.from(bucket).remove(files);
    if (!files.length) return;
  }
}

/**
 * Delete a suspended company for good: its rows (through platform_delete_tenant,
 * which checks the platform owner, the suspension and the typed web name) and
 * then its photos, proofs and invoices. Sign-in accounts are kept.
 */
export async function deleteTenant(formData: FormData) {
  const ctx = await requirePlatformAdmin();
  const id = String(formData.get("tenant_id"));
  if (!/^[0-9a-f-]{36}$/i.test(id)) back("/platform", { error: "Company not found" });
  const { error } = await ctx.supabase.rpc("platform_delete_tenant", { p_tenant_id: id, p_confirm_slug: String(formData.get("confirm_slug") ?? "") });
  if (error) back(`/platform/tenants/${id}`, { error: error.message });
  let filesLeft = false;
  try {
    const admin = createAdminClient();
    for (const bucket of TENANT_BUCKETS) await removeFolder(admin, bucket, id);
  } catch {
    filesLeft = true;
  }
  revalidatePath("/platform");
  back("/platform", { notice: filesLeft ? "deleted-files-left" : "deleted" });
}

/**
 * Reset the password of a company's Owner or Admin, by email. The platform
 * sees no list of a company's people, so the email is typed. Returns a
 * temporary password, shown once.
 */
export async function resetAdminPassword(formData: FormData) {
  await requirePlatformAdmin();
  const tenantId = String(formData.get("tenant_id"));
  const path = `/platform/tenants/${tenantId}`;
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) back(path, { error: "Enter the person's email" });
  const admin = createAdminClient();
  const { data: member } = await admin.from("memberships").select("user_id, role, active, full_name")
    .eq("tenant_id", tenantId).ilike("email", email.replace(/[%_\\]/g, "\\$&")).in("role", ["owner", "admin"]).maybeSingle();
  if (!member || !member.active) back(path, { error: "No active Owner or Admin of this company has that email. The company resets its dispatchers and drivers in Settings." });
  const { data: platform } = await admin.from("platform_admins").select("user_id").eq("user_id", member!.user_id).maybeSingle();
  if (platform) back(path, { error: "That is a platform owner's account. Use Change password or the reset email." });
  const password = randomBytes(9).toString("base64url");
  const { error } = await admin.auth.admin.updateUserById(member!.user_id as string, { password });
  if (error) back(path, { error: "Could not reset the password. Try again." });
  const sent = await sendSignInEmail({ kind: "reset", name: (member!.full_name as string | null) ?? null, companyName: await companyName(tenantId), email, password });
  back(path, { notice: "reset", email, password, ...emailedParam(sent) });
}
