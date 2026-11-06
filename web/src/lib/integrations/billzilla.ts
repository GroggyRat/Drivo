import "server-only";
import { randomUUID } from "node:crypto";
import { linkSecret, signedHeaders } from "@/lib/hmac";
import { serverEnv } from "@/lib/server-env";
import type { BillzillaInvoice, DeliveryUpdate } from "./schemas";

// BillzillaClient: how Drivo talks to BillZilla. The HTTP client follows
// docs/integrations.md; the mock is used until BillZilla's side exists, and
// in local development.

export interface BillzillaClient {
  readonly mode: "live" | "mock";
  /** Confirmed invoices waiting for delivery, changed since `since`. */
  fetchConfirmedInvoices(organisationId: string, since: string | null): Promise<BillzillaInvoice[]>;
  /** Push a delivery result back to the invoice. */
  pushDelivery(organisationId: string, update: DeliveryUpdate): Promise<void>;
}

export class HttpBillzillaClient implements BillzillaClient {
  readonly mode = "live" as const;
  constructor(private readonly baseUrl: string, private readonly masterSecret: string) {}

  async fetchConfirmedInvoices(organisationId: string, since: string | null) {
    const out: BillzillaInvoice[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/api/v1/invoices`);
      url.searchParams.set("status", "confirmed");
      url.searchParams.set("delivery_status", "pending");
      url.searchParams.set("organisation_id", organisationId);
      if (since) url.searchParams.set("updated_since", since);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, {
        headers: signedHeaders(linkSecret(this.masterSecret, organisationId), "invoices.list", "", randomUUID()),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`BillZilla answered ${response.status}`);
      const page = (await response.json()) as { invoices: BillzillaInvoice[]; next_cursor: string | null };
      out.push(...page.invoices);
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }

  async pushDelivery(organisationId: string, update: DeliveryUpdate) {
    const body = JSON.stringify(update);
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/invoices/${encodeURIComponent(update.invoice_id)}/delivery`, {
      method: "POST",
      headers: signedHeaders(linkSecret(this.masterSecret, organisationId), update.event, body, randomUUID()),
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`BillZilla answered ${response.status}`);
  }
}

/** Stand-in BillZilla with a few new invoices for the demo tenant's customers. */
export class MockBillzillaClient implements BillzillaClient {
  readonly mode = "mock" as const;
  static pushed: DeliveryUpdate[] = [];

  async fetchConfirmedInvoices(): Promise<BillzillaInvoice[]> {
    const stamp = new Date();
    const base = 20000 + (stamp.getUTCHours() * 60 + stamp.getUTCMinutes());
    const customers = [
      { id: "BZ-CUST-2005", name: "Nabua Family Store", address: "Nabua" },
      { id: "BZ-CUST-2010", name: "Valelevu Supermarket", address: "Valelevu, Nasinu" },
      { id: "BZ-CUST-2012", name: "Nausori Main Street Store", address: "Main Street, Nausori" },
    ];
    return customers.map((customer, i) => ({
      id: `bz-inv-${base}-${i}`,
      number: `INV-${base}${i}`,
      status: "confirmed",
      confirmed_at: stamp.toISOString(),
      currency: "FJD",
      total: (150 + i * 42.5).toFixed(2),
      cartons: 6 + i * 3,
      customer,
      lines: [
        { sku: "SUGAR-10", description: "Sugar 10 kg", quantity: 2 + i, unit: "bag" },
        { sku: "OIL-4", description: "Cooking oil 4 L", quantity: 3, unit: "bottle" },
      ],
      url: null,
    }));
  }

  async pushDelivery(_organisationId: string, update: DeliveryUpdate) {
    MockBillzillaClient.pushed.push(update);
  }
}

export function getBillzillaClient(): BillzillaClient {
  if (serverEnv.billzillaApiUrl && serverEnv.billzillaWebhookSecret) {
    return new HttpBillzillaClient(serverEnv.billzillaApiUrl, serverEnv.billzillaWebhookSecret);
  }
  return new MockBillzillaClient();
}
