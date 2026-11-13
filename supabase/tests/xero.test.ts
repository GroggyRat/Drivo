import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asService, asUser, createTestDatabase, expectDenied } from "./helpers";
import { A, B, loadFixture } from "./fixtures";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.Client;

const invoice = (n: number, over: Record<string, unknown> = {}) => ({
  id: `xero-inv-${n}`, number: `INV-X${n}`, status: "AUTHORISED", date: "2026-11-13T00:00:00Z", currency: "FJD", total: "184.50", cartons: 7,
  lines: [{ sku: "RICE-10", description: "Rice 10 kg", quantity: 7, unit: null }],
  customer: { id: "xero-contact-1", name: "Samabula Mini Mart", phone: "+679 331 0000", address: "Samabula, Suva" },
  ...over,
});
const ingest = (tenant: string, invoices: unknown[]) =>
  asService(client, async (q) => (await q.query("select public.xero_ingest($1, $2::jsonb) as r", [tenant, JSON.stringify(invoices)])).rows[0].r, { commit: true });
const order = async (xeroId: string) =>
  (await client.query("select o.*, c.name as customer, c.source as customer_source, c.phone from public.orders o join public.customers c on c.id = o.customer_id where o.xero_invoice_id = $1", [xeroId])).rows[0];

beforeAll(async () => {
  db = await createTestDatabase();
  client = db.client;
  await loadFixture(client);
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe("Xero invoices", () => {
  it("arrive as orders ready for delivery, with their customer", async () => {
    expect(await ingest(A.tenant, [invoice(1), invoice(2, { customer: { id: "xero-contact-2", name: "Raiwai Store" } })])).toEqual({ stored: 2, cancelled: 0, skipped: 0 });
    expect(await order("xero-inv-1")).toMatchObject({
      tenant_id: A.tenant, source: "xero", reference: "INV-X1", cartons: 7, total_amount: "184.50", delivery_status: "ready",
      xero_status: "AUTHORISED", customer: "Samabula Mini Mart", customer_source: "xero", phone: "+679 331 0000",
    });
  });

  it("update in place when sent again, and keep a phone number Xero no longer sends", async () => {
    await ingest(A.tenant, [invoice(1, { cartons: 9, status: "PAID", customer: { id: "xero-contact-1", name: "Samabula Mini Mart Ltd" } })]);
    expect(await order("xero-inv-1")).toMatchObject({ cartons: 9, xero_status: "PAID", delivery_status: "ready", customer: "Samabula Mini Mart Ltd", phone: "+679 331 0000" });
    expect((await client.query("select count(*)::int as n from public.orders where xero_invoice_id = 'xero-inv-1'")).rows[0].n).toBe(1);
  });

  it("keep both when an order added by hand already uses the invoice number", async () => {
    await ingest(A.tenant, [invoice(3, { number: "ORD-a2" })]);
    expect((await order("xero-inv-3")).reference).toBe("ORD-a2 (Xero)");
    await ingest(A.tenant, [invoice(3, { number: "ORD-a2" })]);
    expect((await order("xero-inv-3")).reference).toBe("ORD-a2 (Xero)");
  });

  it("are cancelled when voided in Xero, and come back if approved again", async () => {
    expect(await ingest(A.tenant, [{ id: "xero-inv-2", status: "VOIDED" }, { id: "never-seen", status: "DELETED" }])).toEqual({ stored: 0, cancelled: 1, skipped: 1 });
    expect(await order("xero-inv-2")).toMatchObject({ delivery_status: "cancelled", xero_status: "VOIDED" });
    await ingest(A.tenant, [invoice(2, { customer: { id: "xero-contact-2", name: "Raiwai Store" } })]);
    expect((await order("xero-inv-2")).delivery_status).toBe("ready");
  });

  it("cannot be added, edited or renamed by people in Drivo, but the customer can be given a shop", async () => {
    const o = await order("xero-inv-1");
    const edited = await asUser(client, A.admin, async (q) => (await q.query("update public.orders set cartons = 1 where id = $1", [o.id])).rowCount);
    expect(edited).toBe(0);
    await expectDenied(asUser(client, A.admin, (q) =>
      q.query("insert into public.orders (tenant_id, source, xero_invoice_id, reference, customer_id, customer_name) values ($1, 'xero', 'fake', 'FAKE-1', $2, 'X')", [A.tenant, o.customer_id])));
    await expectDenied(asUser(client, A.admin, (q) =>
      q.query("insert into public.customers (tenant_id, source, xero_contact_id, name) values ($1, 'xero', 'fake', 'X')", [A.tenant])));
    await expect(asUser(client, A.dispatcher, (q) => q.query("update public.customers set name = 'Renamed' where id = $1", [o.customer_id])))
      .rejects.toThrow(/changed in Xero/);
    const moved = await asUser(client, A.dispatcher, async (q) => (await q.query("update public.customers set location_id = $2 where id = $1", [o.customer_id, A.shop1])).rowCount);
    expect(moved).toBe(1);
  });

  it("stay in their own company: the same Xero ids in another company are separate rows", async () => {
    await ingest(B.tenant, [invoice(1)]);
    const rows = (await client.query("select tenant_id from public.orders where xero_invoice_id = 'xero-inv-1' order by tenant_id")).rows.map((r) => r.tenant_id);
    expect(rows).toEqual([A.tenant, B.tenant]);
    const seen = await asUser(client, A.admin, async (q) => (await q.query("select tenant_id from public.orders where xero_invoice_id = 'xero-inv-1'")).rows.map((r) => r.tenant_id));
    expect(seen).toEqual([A.tenant]);
  });
});

describe("the Xero connection", () => {
  it("can only be written and ingested by the server", async () => {
    await expectDenied(asUser(client, A.owner, (q) => q.query("select public.xero_ingest($1, '[]'::jsonb)", [A.tenant])));
    await expectDenied(asUser(client, A.owner, (q) => q.query("update public.xero_connections set xero_tenant_id = 'xero-org-b' where tenant_id = $1", [A.tenant])));
    await expectDenied(asUser(client, A.owner, (q) => q.query("delete from public.xero_connections where tenant_id = $1", [A.tenant])));
    await expectDenied(asUser(client, A.owner, (q) => q.query("insert into public.xero_connections (tenant_id, xero_tenant_id, org_name, token_ciphertext, import_from) values ($1, 'x', 'x', 'x', current_date)", [A.tenant])));
  });

  it("shows managers its name and last sync, never the tokens or Xero ids; drivers see nothing", async () => {
    const seen = await asUser(client, A.dispatcher, async (q) => (await q.query("select tenant_id, org_name from public.xero_connections")).rows);
    expect(seen).toEqual([{ tenant_id: A.tenant, org_name: "Tenant A Ltd" }]);
    for (const column of ["token_ciphertext", "xero_tenant_id", "xero_connection_id", "*"]) {
      await expectDenied(asUser(client, A.owner, (q) => q.query(`select ${column} from public.xero_connections`)));
    }
    expect(await asUser(client, A.driver1, async (q) => (await q.query("select tenant_id from public.xero_connections")).rowCount)).toBe(0);
  });

  it("refuses a company that is not connected, or is suspended", async () => {
    await client.query("delete from public.xero_connections where tenant_id = $1", [B.tenant]);
    await expect(ingest(B.tenant, [invoice(9)])).rejects.toThrow(/not connected to Xero/);
    await client.query("update public.tenants set status = 'suspended', suspended_at = now() where id = $1", [A.tenant]);
    await expect(ingest(A.tenant, [invoice(9)])).rejects.toThrow(/not connected to Xero/);
  });
});
