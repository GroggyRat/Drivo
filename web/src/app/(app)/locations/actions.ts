"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parseCsv } from "@/lib/csv";
import { requireAdmin } from "@/lib/tenant";

const done = (path: string) => {
  revalidatePath("/locations");
  revalidatePath("/plan");
  revalidatePath("/orders");
  redirect(path);
};
const fail = (path: string, message: string) => redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);

export async function approveLocation(formData: FormData) {
  const ctx = await requireAdmin();
  const id = String(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  const customerIds = formData.getAll("customerIds").map(String).filter(Boolean);
  if (name) await ctx.supabase.rpc("update_location", { p_location_id: id, p_name: name });
  const { error } = await ctx.supabase.rpc("review_location", { p_location_id: id, p_approve: true, p_reason: null, p_customer_ids: customerIds.length ? customerIds : null });
  if (error) fail("/locations", error.message);
  done(`/locations?notice=approved${customerIds.length ? `&linked=${customerIds.length}` : ""}`);
}

export async function rejectLocation(formData: FormData) {
  const ctx = await requireAdmin();
  const { error } = await ctx.supabase.rpc("review_location", {
    p_location_id: String(formData.get("id")),
    p_approve: false,
    p_reason: String(formData.get("reason") ?? "") || null,
  });
  if (error) fail("/locations", error.message);
  done("/locations?notice=rejected");
}

const locationSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(200),
  type: z.enum(["shop", "depot", "fuel", "hazard"]),
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  landmark_directions: z.string().max(2000).optional(),
  address: z.string().max(300).optional(),
  expires_at: z.string().optional(),
});

export async function createLocation(formData: FormData) {
  const ctx = await requireAdmin();
  const back = formData.get("type") === "hazard" ? "/locations?tab=hazards" : "/locations?tab=all";
  const parsed = locationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) fail(back, parsed.error.issues[0].message);
  const d = parsed.data!;
  const { data, error } = await ctx.supabase.rpc("submit_location", {
    p_tenant_id: ctx.tenant.id, p_name: d.name, p_type: d.type, p_lon: d.lon, p_lat: d.lat, p_accuracy_m: null,
    p_landmark_directions: d.landmark_directions || null, p_photo_path: null, p_address: d.address || null,
    p_expires_at: d.type === "hazard" && d.expires_at ? new Date(d.expires_at).toISOString() : null,
  });
  if (error) fail(back, error.message);
  const nearby = (data as { nearby: { name: string; distance_m: number }[] }).nearby;
  done(`${back}&notice=added${nearby.length ? `&nearby=${encodeURIComponent(nearby.map((n) => `${n.name} (${Math.round(n.distance_m)} m)`).join(", "))}` : ""}`);
}

export async function updateLocation(formData: FormData) {
  const ctx = await requireAdmin();
  const id = String(formData.get("id"));
  const parsed = locationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) fail(`/locations/${id}`, parsed.error.issues[0].message);
  const d = parsed.data!;
  const { error } = await ctx.supabase.rpc("update_location", {
    p_location_id: id, p_name: d.name, p_type: d.type, p_lon: d.lon, p_lat: d.lat,
    p_landmark_directions: d.landmark_directions ?? null, p_address: d.address ?? null,
    p_expires_at: d.type === "hazard" && d.expires_at ? new Date(d.expires_at).toISOString() : null,
    p_clear_expiry: d.type !== "hazard" || !d.expires_at,
  });
  if (error) fail(`/locations/${id}`, error.message);
  done(`/locations/${id}?notice=saved`);
}

export async function linkCustomer(formData: FormData) {
  const ctx = await requireAdmin();
  const id = String(formData.get("locationId"));
  const customerId = String(formData.get("customerId"));
  const { error } = await ctx.supabase.from("customers").update({ location_id: id }).eq("id", customerId).eq("tenant_id", ctx.tenant.id);
  if (error) fail(`/locations/${id}`, error.message);
  done(`/locations/${id}?notice=linked`);
}

export async function unlinkCustomer(formData: FormData) {
  const ctx = await requireAdmin();
  const id = String(formData.get("locationId"));
  await ctx.supabase.from("customers").update({ location_id: null }).eq("id", String(formData.get("customerId"))).eq("tenant_id", ctx.tenant.id);
  done(`/locations/${id}?notice=unlinked`);
}

/**
 * CSV columns: name, type (shop, depot, fuel or hazard), latitude, longitude,
 * and optionally address, directions and billzilla_customer_id (links the
 * customer to the new location).
 */
export async function importLocations(formData: FormData) {
  const ctx = await requireAdmin();
  const file = formData.get("file");
  const rows = parseCsv(file instanceof File ? await file.text() : "");
  let added = 0;
  const problems: string[] = [];
  for (const [i, r] of rows.entries()) {
    const parsed = locationSchema.safeParse({
      name: r.name, type: (r.type || "shop").toLowerCase(), lat: r.latitude ?? r.lat, lon: r.longitude ?? r.lon ?? r.lng,
      landmark_directions: r.directions || undefined, address: r.address || undefined,
    });
    if (!parsed.success) { problems.push(`Row ${i + 2}: ${parsed.error.issues[0].message}`); continue; }
    const d = parsed.data;
    const { data, error } = await ctx.supabase.rpc("submit_location", {
      p_tenant_id: ctx.tenant.id, p_name: d.name, p_type: d.type, p_lon: d.lon, p_lat: d.lat, p_accuracy_m: null,
      p_landmark_directions: d.landmark_directions ?? null, p_photo_path: null, p_address: d.address ?? null, p_expires_at: null,
    });
    if (error) { problems.push(`Row ${i + 2}: ${error.message}`); continue; }
    added++;
    const result = data as { id: string; nearby: { name: string }[] };
    if (result.nearby.length) problems.push(`Row ${i + 2}: added, but within 30 m of ${result.nearby[0].name}`);
    if (r.billzilla_customer_id) {
      await ctx.supabase.from("customers").update({ location_id: result.id }).eq("tenant_id", ctx.tenant.id).eq("billzilla_customer_id", r.billzilla_customer_id);
    }
  }
  done(`/locations?tab=import&notice=imported&count=${added}${problems.length ? `&problems=${encodeURIComponent(problems.slice(0, 8).join("; "))}` : ""}`);
}
