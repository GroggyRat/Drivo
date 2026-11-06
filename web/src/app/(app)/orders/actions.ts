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
