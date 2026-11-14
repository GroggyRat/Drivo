"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { disconnectXero, syncXero } from "@/lib/integrations/xero";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/tenant";

const go = (tab: string, params: Record<string, string> = {}) => {
  revalidatePath("/settings");
  redirect(`/settings?${new URLSearchParams({ tab, ...params })}`);
};

const personSchema = z.object({
  full_name: z.string().trim().min(1, "Enter a name").max(200),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  phone: z.string().trim().max(30).optional(),
  role: z.enum(["admin", "dispatcher", "driver"]),
  kaiworkforce_employee_id: z.string().trim().max(100).optional(),
});

/** Adds a person: creates their sign-in account (server only) and their membership. */
export async function addPerson(formData: FormData) {
  const ctx = await requireAdmin();
  const parsed = personSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go("people", { error: parsed.error.issues[0].message });
  const d = parsed.data!;
  const admin = createAdminClient();
  const password = randomBytes(9).toString("base64url");
  let userId: string | undefined;
  const created = await admin.auth.admin.createUser({ email: d.email, password, email_confirm: true, user_metadata: { full_name: d.full_name } });
  if (created.data.user) userId = created.data.user.id;
  else {
    // Already has a KaiTech or Drivo account (for example in another company): add them here too.
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    userId = list?.users.find((u) => u.email?.toLowerCase() === d.email)?.id;
    if (!userId) go("people", { error: "Could not create the account" });
  }
  const { error } = await admin.from("memberships").insert({
    tenant_id: ctx.tenant.id, user_id: userId, role: d.role, full_name: d.full_name, email: d.email,
    phone: d.phone || null, kaiworkforce_employee_id: d.kaiworkforce_employee_id || null,
  });
  if (error) go("people", { error: error.code === "23505" ? "This person is already in your company" : "Could not add this person" });
  go("people", created.data.user ? { notice: "added", email: d.email, password } : { notice: "added-existing" });
}

/**
 * Reset a person's password to a temporary one, shown once to the Owner or
 * Admin to pass on. Same reach as editing a person: not yourself (use Change
 * password), and only the Owner can reset the Owner. Refused when the person
 * also belongs to another company, because the new password would open that
 * company too; they use the reset email instead.
 */
export async function resetPassword(formData: FormData) {
  const ctx = await requireAdmin();
  const userId = String(formData.get("user_id"));
  if (userId === ctx.userId) go("people", { error: "Use Change password for your own account." });
  const admin = createAdminClient();
  const { data: memberships } = await admin.from("memberships").select("tenant_id, role, email, full_name, active").eq("user_id", userId);
  const here = (memberships ?? []).find((m) => m.tenant_id === ctx.tenant.id);
  if (!here || !here.active) go("people", { error: "That person does not have access to this company." });
  if (here!.role === "owner" && ctx.role !== "owner") go("people", { error: "Only the Owner can reset the Owner's password." });
  const { data: platform } = await admin.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
  if (platform || (memberships ?? []).some((m) => m.tenant_id !== ctx.tenant.id)) {
    go("people", { error: `${here!.full_name} also uses this sign-in for another company, so it cannot be reset here. Ask them to use "Forgot password" on the sign-in page.` });
  }
  const password = randomBytes(9).toString("base64url");
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) go("people", { error: "Could not reset the password. Try again." });
  go("people", { notice: "reset", email: here!.email ?? here!.full_name, password });
}

export async function updatePerson(formData: FormData) {
  const ctx = await requireAdmin();
  const userId = String(formData.get("user_id"));
  const { error } = await ctx.supabase
    .from("memberships")
    .update({
      role: String(formData.get("role")),
      kaiworkforce_employee_id: String(formData.get("kaiworkforce_employee_id") ?? "") || null,
    })
    .eq("tenant_id", ctx.tenant.id)
    .eq("user_id", userId);
  go("people", error ? { error: error.message } : { notice: "saved" });
}

export async function setPersonActive(formData: FormData) {
  const ctx = await requireAdmin();
  const active = formData.get("active") === "true";
  const { error } = await ctx.supabase.from("memberships").update({ active }).eq("tenant_id", ctx.tenant.id).eq("user_id", String(formData.get("user_id")));
  go("people", error ? { error: error.message } : { notice: active ? "reactivated" : "deactivated" });
}

const vehicleSchema = z.object({
  plate: z.string().trim().toUpperCase().regex(/^[A-Z0-9 ]{2,12}$/, "Plates use letters, numbers and spaces"),
  model: z.string().trim().max(100).optional(),
  fuel_type: z.enum(["diesel", "petrol", "electric", "hybrid", "lpg"]),
  fuel_l_per_100km: z.coerce.number().positive("Enter fuel use above 0").max(99),
  capacity_cartons: z.coerce.number().int().positive().optional().or(z.literal("").transform(() => undefined)),
});

export async function saveVehicle(formData: FormData) {
  const ctx = await requireAdmin();
  const parsed = vehicleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go("vehicles", { error: parsed.error.issues[0].message });
  const id = String(formData.get("id") ?? "");
  const row = { ...parsed.data!, model: parsed.data!.model || null, capacity_cartons: parsed.data!.capacity_cartons ?? null };
  const { error } = id
    ? await ctx.supabase.from("vehicles").update(row).eq("tenant_id", ctx.tenant.id).eq("id", id)
    : await ctx.supabase.from("vehicles").insert({ ...row, tenant_id: ctx.tenant.id });
  go("vehicles", error ? { error: error.code === "23505" ? "That plate is already in the list" : error.message } : { notice: "saved" });
}

export async function setVehicleActive(formData: FormData) {
  const ctx = await requireAdmin();
  await ctx.supabase.from("vehicles").update({ active: formData.get("active") === "true" }).eq("tenant_id", ctx.tenant.id).eq("id", String(formData.get("id")));
  go("vehicles", { notice: "saved" });
}

export async function addDepot(formData: FormData) {
  const ctx = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const lat = Number(formData.get("lat"));
  const lon = Number(formData.get("lon"));
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) go("depots", { error: "Enter a name and a position" });
  const { error } = await ctx.supabase.from("depots").insert({
    tenant_id: ctx.tenant.id, name, address: String(formData.get("address") ?? "") || null, point: `SRID=4326;POINT(${lon} ${lat})`,
  });
  go("depots", error ? { error: error.code === "23505" ? "A depot with that name exists" : error.message } : { notice: "saved" });
}

export async function setDepotActive(formData: FormData) {
  const ctx = await requireAdmin();
  await ctx.supabase.from("depots").update({ active: formData.get("active") === "true" }).eq("tenant_id", ctx.tenant.id).eq("id", String(formData.get("id")));
  go("depots", { notice: "saved" });
}

const settingsSchema = z.object({
  urban_speed_limit_kmh: z.coerce.number().int().min(10).max(130),
  highway_speed_limit_kmh: z.coerce.number().int().min(10).max(130),
  speed_alert_after_s: z.coerce.number().int().min(1).max(120),
  speed_tolerance_kmh: z.coerce.number().int().min(0).max(30),
  arrival_radius_m: z.coerce.number().int().min(10).max(500),
});

export async function saveSpeedSettings(formData: FormData) {
  const ctx = await requireAdmin();
  const parsed = settingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go("speed", { error: "Check the numbers: limits 10 to 130 km/h, alert after 1 to 120 seconds" });
  const { error } = await ctx.supabase.from("tenant_settings").update(parsed.data!).eq("tenant_id", ctx.tenant.id);
  go("speed", error ? { error: error.message } : { notice: "saved" });
}

export async function saveFuelSettings(formData: FormData) {
  const ctx = await requireAdmin();
  const price = String(formData.get("fuel_price_per_l") ?? "").trim();
  const idle = Number(formData.get("idle_fuel_l_per_stop"));
  if ((price && !(Number(price) > 0)) || !(idle >= 0)) go("fuel", { error: "Enter a price above 0 and an idle allowance of 0 or more" });
  const { error } = await ctx.supabase
    .from("tenant_settings")
    .update({ fuel_price_per_l: price ? Number(price) : null, idle_fuel_l_per_stop: idle })
    .eq("tenant_id", ctx.tenant.id);
  go("fuel", error ? { error: error.message } : { notice: "saved" });
}

/** "Sync from Xero now": read what changed in Xero since the last sync. */
export async function syncXeroNow() {
  const ctx = await requireAdmin();
  const result = await syncXero(createAdminClient(), ctx.tenant.id);
  revalidatePath("/orders");
  revalidatePath("/plan");
  if (result.ok) go("integrations", { notice: "xero-synced", count: String(result.stored) });
  else go("integrations", { error: result.reason === "busy" ? "A Xero sync is already running. Try again in a minute." : result.reason === "not_connected" ? "Xero is not connected." : result.message ?? "Xero could not be reached." });
}

/** Disconnect Xero. Customers and invoices already brought in stay in Drivo. */
export async function disconnectXeroNow() {
  const ctx = await requireAdmin();
  await disconnectXero(createAdminClient(), ctx.tenant.id);
  go("integrations", { notice: "xero-disconnected" });
}
