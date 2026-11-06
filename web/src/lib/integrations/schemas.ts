import { z } from "zod";

// Payloads from docs/integrations.md.

export const billzillaCustomer = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  phone: z.string().max(50).nullish(),
  address: z.string().max(500).nullish(),
});

export const billzillaInvoice = z.object({
  id: z.string().min(1).max(200),
  number: z.string().min(1).max(100),
  status: z.string().max(50).default("confirmed"),
  confirmed_at: z.string().nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).default("FJD"),
  total: z.union([z.string(), z.number()]).nullish(),
  cartons: z.number().int().min(0).default(0),
  customer: billzillaCustomer,
  lines: z
    .array(z.object({ sku: z.string().nullish(), description: z.string(), quantity: z.number(), unit: z.string().nullish() }))
    .default([]),
  url: z.string().url().nullish(),
});

export const billzillaWebhook = z.discriminatedUnion("event", [
  z.object({ event: z.literal("invoice.confirmed"), organisation_id: z.string(), invoice: billzillaInvoice }),
  z.object({
    event: z.literal("invoice.cancelled"),
    organisation_id: z.string(),
    invoice: z.object({ id: z.string(), cancelled_at: z.string().nullish() }),
  }),
  z.object({ event: z.literal("customer.updated"), organisation_id: z.string(), customer: billzillaCustomer }),
]);
export type BillzillaWebhook = z.infer<typeof billzillaWebhook>;
export type BillzillaInvoice = z.infer<typeof billzillaInvoice>;

export const kaiworkforceWebhook = z.object({
  event: z.enum(["shift.clock_in", "shift.clock_out"]),
  company_id: z.string().min(1),
  employee_id: z.string().min(1),
  shift_id: z.string().min(1),
  at: z.string(),
});
export type KaiworkforceWebhook = z.infer<typeof kaiworkforceWebhook>;

export type DeliveryUpdate = {
  event: "delivery.updated";
  organisation_id: string;
  invoice_id: string;
  status: "delivered" | "partially_delivered" | "failed";
  delivered_at: string | null;
  received_by: string | null;
  delivered_in_full: boolean;
  notes: string | null;
  driver_name: string | null;
  vehicle_plate: string | null;
  proof: { photo_url: string | null; signature_url: string | null; expires_at: string | null };
};
