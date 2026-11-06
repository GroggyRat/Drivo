"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getBillzillaClient } from "@/lib/integrations/billzilla";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireManager } from "@/lib/tenant";
import { parseCsv } from "@/lib/csv";

/** "Sync from BillZilla": pull confirmed invoices and store them like webhooks do. */
export async function syncFromBillzilla() {
  const ctx = await requireManager();
  if (!ctx.tenant.billzilla_enabled || !ctx.tenant.billzilla_org_id) redirect("/orders?notice=not-linked");
  const client = getBillzillaClient();
  const invoices = await client.fetchConfirmedInvoices(ctx.tenant.billzilla_org_id, null);
  const admin = createAdminClient();
  let stored = 0;
  for (const invoice of invoices) {
    const { error } = await admin.rpc("billzilla_ingest", {
      p_organisation_id: ctx.tenant.billzilla_org_id,
      p_event: "invoice.confirmed",
      p_payload: { invoice },
    });
    if (!error) stored++;
  }
  revalidatePath("/orders");
  revalidatePath("/plan");
  redirect(`/orders?notice=synced&count=${stored}${client.mode === "mock" ? "&mock=1" : ""}`);
}

const orderSchema = z.object({
  customerId: z.string().uuid(),
  reference: z.string().trim().min(1, "Enter an order number").max(100),
  cartons: z.coerce.number().int().min(0).max(10000),
  notes: z.string().max(500).optional(),
});

export async function addOrder(formData: FormData) {
  const ctx = await requireManager();
  const parsed = orderSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/orders?tab=add&error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  const { data: customer } = await ctx.supabase.from("customers").select("name").eq("id", parsed.data.customerId).single();
  const { error } = await ctx.supabase.from("orders").insert({
    tenant_id: ctx.tenant.id,
    source: "manual",
    reference: parsed.data.reference,
    customer_id: parsed.data.customerId,
    customer_name: customer?.name ?? "Customer",
    cartons: parsed.data.cartons,
    line_items: parsed.data.notes ? [{ description: parsed.data.notes, quantity: 1 }] : [],
  });
  if (error) redirect(`/orders?tab=add&error=${encodeURIComponent(error.code === "23505" ? "That order number is already used" : "Could not add the order")}`);
  revalidatePath("/orders");
  redirect("/orders?notice=added");
}

export async function addCustomer(formData: FormData) {
  const ctx = await requireManager();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/orders?tab=add&error=Enter+a+customer+name");
  await ctx.supabase.from("customers").insert({ tenant_id: ctx.tenant.id, source: "manual", name, phone: String(formData.get("phone") ?? "") || null });
  revalidatePath("/orders");
  redirect("/orders?tab=add&notice=customer-added");
}

/**
 * CSV columns: reference, customer, cartons (customer must already exist in
 * Drivo by name, or is created without a location).
 */
export async function importOrders(formData: FormData) {
  const ctx = await requireManager();
  const file = formData.get("file");
  const text = file instanceof File ? await file.text() : String(formData.get("csv") ?? "");
  const rows = parseCsv(text);
  const { data: customers } = await ctx.supabase.from("customers").select("id, name").eq("tenant_id", ctx.tenant.id);
  const byName = new Map((customers ?? []).map((c) => [String(c.name).toLowerCase(), c.id as string]));
  let added = 0;
  const problems: string[] = [];
  for (const [i, r] of rows.entries()) {
    const reference = (r.reference ?? r.order ?? "").trim();
    const customerName = (r.customer ?? "").trim();
    if (!reference || !customerName) {
      problems.push(`Row ${i + 2}: needs reference and customer`);
      continue;
    }
    let customerId = byName.get(customerName.toLowerCase());
    if (!customerId) {
      const { data } = await ctx.supabase.from("customers").insert({ tenant_id: ctx.tenant.id, source: "csv", name: customerName }).select("id").single();
      customerId = data?.id;
      if (customerId) byName.set(customerName.toLowerCase(), customerId);
    }
    const { error } = await ctx.supabase.from("orders").insert({
      tenant_id: ctx.tenant.id, source: "csv", reference, customer_id: customerId, customer_name: customerName,
      cartons: Math.max(0, parseInt(r.cartons ?? "0", 10) || 0),
    });
    if (error) problems.push(`Row ${i + 2}: ${error.code === "23505" ? "order number already used" : "not added"}`);
    else added++;
  }
  revalidatePath("/orders");
  redirect(`/orders?tab=import&notice=imported&count=${added}${problems.length ? `&problems=${encodeURIComponent(problems.slice(0, 5).join("; "))}` : ""}`);
}

const deliverySchema = z.object({
  locationId: z.string().min(1),
  placeName: z.string().trim().max(200).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  directions: z.string().trim().max(2000).optional(),
  customer: z.string().trim().max(200).optional(),
  reference: z.string().trim().min(1, "Enter the invoice number").max(100),
  cartons: z.coerce.number().int().min(0).max(10000),
  total: z.string().trim().optional(),
  notes: z.string().trim().max(500).optional(),
  invoicePath: z.string().optional(),
});

/**
 * "Add delivery", for companies without BillZilla: a place (known or a new
 * pin), the invoice number and its PDF. The customer is found or added at
 * that place.
 */
export async function addDelivery(formData: FormData) {
  const ctx = await requireManager();
  const back = "/orders?tab=add";
  const parsed = deliverySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`${back}&error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  const d = parsed.data!;
  const total = d.total ? Number(d.total.replace(/[^0-9.]/g, "")) : null;
  if (total !== null && !(total >= 0)) redirect(`${back}&error=${encodeURIComponent("Enter the total as a number, for example 217.50")}`);
  if (d.invoicePath && !(d.invoicePath.startsWith(`${ctx.tenant.id}/`) && d.invoicePath.endsWith(".pdf"))) redirect(`${back}&error=Upload+the+PDF+again`);

  // Where it goes.
  let locationId = d.locationId;
  let placeName = "";
  let approved = true;
  if (locationId === "new") {
    if (!d.placeName || d.lat === undefined || d.lon === undefined) redirect(`${back}&error=${encodeURIComponent("Name the shop and click the map to place the pin")}`);
    const { data, error } = await ctx.supabase.rpc("submit_location", {
      p_tenant_id: ctx.tenant.id, p_name: d.placeName, p_type: "shop", p_lon: d.lon, p_lat: d.lat, p_accuracy_m: null,
      p_landmark_directions: d.directions || null, p_photo_path: null, p_address: null, p_expires_at: null,
    });
    if (error) redirect(`${back}&error=${encodeURIComponent(error.message)}`);
    const r = data as { id: string; status: string };
    locationId = r.id;
    approved = r.status === "approved";
    placeName = d.placeName!;
  } else {
    const { data: loc } = await ctx.supabase.from("locations").select("name").eq("id", locationId).eq("tenant_id", ctx.tenant.id).eq("status", "approved").maybeSingle();
    if (!loc) redirect(`${back}&error=${encodeURIComponent("Choose the place again")}`);
    placeName = loc!.name;
  }

  // Who it is for: an existing customer at this place, or a new one.
  const customerName = d.customer || placeName;
  const { data: existing } = await ctx.supabase.from("customers").select("id, location_id")
    .eq("tenant_id", ctx.tenant.id).ilike("name", customerName.replace(/[%_]/g, "\\$&")).eq("active", true);
  let customerId = (existing ?? []).find((c) => c.location_id === locationId)?.id as string | undefined;
  if (!customerId) {
    const { data: created, error } = await ctx.supabase.from("customers")
      .insert({ tenant_id: ctx.tenant.id, source: "manual", name: customerName, location_id: approved ? locationId : null })
      .select("id").single();
    if (error || !created) redirect(`${back}&error=${encodeURIComponent("Could not add the customer")}`);
    customerId = created!.id;
  }

  const { error } = await ctx.supabase.from("orders").insert({
    tenant_id: ctx.tenant.id,
    source: "manual",
    reference: d.reference,
    customer_id: customerId,
    customer_name: customerName,
    cartons: d.cartons,
    total_amount: total,
    line_items: d.notes ? [{ description: d.notes, quantity: 1 }] : [],
    invoice_pdf_path: d.invoicePath || null,
    confirmed_at: new Date().toISOString(),
  });
  if (error) redirect(`${back}&error=${encodeURIComponent(error.code === "23505" ? "That invoice number is already in Drivo" : "Could not add the delivery")}`);
  revalidatePath("/orders");
  revalidatePath("/plan");
  revalidatePath("/locations");
  redirect(`/orders?notice=added${approved ? "" : "&pending=1"}`);
}
