import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, createTestDatabase, expectDenied } from "./helpers";
import { A, B, PLATFORM_ADMIN, loadFixture } from "./fixtures";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = db.client;
  await loadFixture(client);
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe("platform functions", () => {
  it("list tenants with counts only, never tenant content", async () => {
    const rows = await asUser(client, PLATFORM_ADMIN, async (q) => (await q.query("select * from public.platform_list_tenants()")).rows);
    expect(rows.map((r) => r.slug)).toEqual(["tenant-a", "tenant-b"]);
    expect(rows[0]).toMatchObject({ people: 5, drivers: 2, vehicles: 1, routes_last_30_days: 2, billzilla_linked: false });
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["billzilla_linked", "created_at", "drivers", "id", "kaiworkforce_linked", "name", "people", "road_alerts_enabled", "routes_last_30_days", "slug", "status", "vehicles"],
    );
  });

  it("create a tenant with a slug made from its name, Fiji time and default settings", async () => {
    const id = await asUser(
      client,
      PLATFORM_ADMIN,
      async (q) => (await q.query("select public.platform_create_tenant('Bula Wholesale Ltd') as id")).rows[0].id,
      { commit: true },
    );
    const settings = (await client.query(
      "select t.slug, t.time_zone, s.urban_speed_limit_kmh, s.highway_speed_limit_kmh, s.currency, s.arrival_radius_m from public.tenants t join public.tenant_settings s on s.tenant_id = t.id where t.id = $1",
      [id],
    )).rows[0];
    expect(settings).toEqual({
      slug: "bula-wholesale-ltd", time_zone: "Pacific/Fiji",
      urban_speed_limit_kmh: 50, highway_speed_limit_kmh: 80, currency: "FJD", arrival_radius_m: 50,
    });
    // Town zones come with it: 50 in central Suva, 80 on the highway past Pacific Harbour.
    const limit = async (lon: number, lat: number) =>
      (await client.query("select limit_kmh, zone_name from app.speed_limit_at($1, app.make_point($2, $3))", [id, lon, lat])).rows[0];
    expect(await limit(178.4419, -18.1416)).toEqual({ limit_kmh: 50, zone_name: "Suva, Lami and Nasinu" });
    expect(await limit(178.07, -18.24)).toEqual({ limit_kmh: 80, zone_name: null });
  });

  it("refuse an unknown time zone", async () => {
    await expect(
      asUser(client, PLATFORM_ADMIN, (q) => q.query("select public.platform_create_tenant('X Co', null, 'Mars/Base')")),
    ).rejects.toThrow(/Unknown time zone/);
  });

  it("suspend and reactivate a tenant", async () => {
    await asUser(client, PLATFORM_ADMIN, (q) => q.query("select public.platform_set_tenant_status($1, 'suspended')", [B.tenant]), { commit: true });
    const suspended = (await client.query("select status, suspended_at is not null as stamped from public.tenants where id = $1", [B.tenant])).rows[0];
    expect(suspended).toEqual({ status: "suspended", stamped: true });
    await asUser(client, PLATFORM_ADMIN, (q) => q.query("select public.platform_set_tenant_status($1, 'active')", [B.tenant]), { commit: true });
    const active = (await client.query("select status, suspended_at from public.tenants where id = $1", [B.tenant])).rows[0];
    expect(active).toEqual({ status: "active", suspended_at: null });
  });

  it("link a tenant to BillZilla and KaiWorkforce, and unlink with an empty string", async () => {
    const read = async () =>
      (await client.query("select billzilla_org_id, billzilla_enabled, kaiworkforce_company_id, kaiworkforce_enabled from public.tenants where id = $1", [A.tenant])).rows[0];
    await asUser(client, PLATFORM_ADMIN, (q) => q.query("select public.platform_link_tenant($1, 'bz-org-77', 'kw-co-12')", [A.tenant]), { commit: true });
    const after = await read();
    await asUser(client, PLATFORM_ADMIN, (q) => q.query("select public.platform_link_tenant($1, '', null)", [A.tenant]), { commit: true });
    const { kaiworkforce_enabled: _unused, ...unlinked } = await read();
    const linked = { after, unlinked };
    expect(linked.after).toEqual({ billzilla_org_id: "bz-org-77", billzilla_enabled: true, kaiworkforce_company_id: "kw-co-12", kaiworkforce_enabled: true });
    expect(linked.unlinked).toEqual({ billzilla_org_id: null, billzilla_enabled: false, kaiworkforce_company_id: "kw-co-12" });
  });

  it("two tenants cannot share a BillZilla organisation", async () => {
    await expect(
      asUser(client, PLATFORM_ADMIN, async (q) => {
        await q.query("select public.platform_link_tenant($1, 'bz-shared')", [A.tenant]);
        await q.query("select public.platform_link_tenant($1, 'bz-shared')", [B.tenant]);
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("are refused to tenant Owners and everyone else", async () => {
    for (const sql of [
      "select * from public.platform_list_tenants()",
      "select public.platform_create_tenant('Sneaky')",
      `select public.platform_set_tenant_status('${B.tenant}', 'suspended')`,
      `select public.platform_link_tenant('${A.tenant}', 'x')`,
    ]) {
      await expectDenied(asUser(client, A.owner, (q) => q.query(sql)));
    }
  });
});

describe("billing", () => {
  const billing = async () =>
    asUser(client, PLATFORM_ADMIN, async (q) => (await q.query("select slug, monthly_total::float, next_due_on::text, days_until_due, months_due, amount_due::float, last_paid_amount::float from public.platform_billing() where slug in ('tenant-a', 'tenant-b') order by slug")).rows);
  const today = async (offset = 0) => (await client.query("select (app.billing_today() + $1::int)::text as d", [offset])).rows[0].d;

  it("lists every company with what is due and when", async () => {
    const rows = await billing();
    expect(rows[0]).toEqual({ slug: "tenant-a", monthly_total: 80, next_due_on: await today(10), days_until_due: 10, months_due: 0, amount_due: 0, last_paid_amount: 80 });
  });

  it("adds the road alerts add-on, counts a month for each due date passed, and moves on when paid", async () => {
    const due = await today(-40);
    await asUser(client, PLATFORM_ADMIN, async (q) => {
      await q.query("select public.platform_set_road_alerts($1, true)", [A.tenant]);
      await q.query("select public.platform_set_billing($1, 120, $2::date)", [A.tenant, due]);
    }, { commit: true });
    expect((await billing())[0]).toMatchObject({ monthly_total: 145, days_until_due: -40, months_due: 2, amount_due: 290 });
    const next = await asUser(client, PLATFORM_ADMIN, async (q) =>
      (await q.query("select public.platform_record_payment($1, 290, null, 2, 'Bank transfer 1182')::text as d", [A.tenant])).rows[0].d, { commit: true });
    const row = (await billing())[0];
    expect(row).toMatchObject({ next_due_on: next, months_due: 0, amount_due: 0, last_paid_amount: 290 });
    expect(row.days_until_due).toBeGreaterThan(0);
    const history = await asUser(client, PLATFORM_ADMIN, async (q) => (await q.query("select amount::float, months, reference from public.platform_tenant_payments($1)", [A.tenant])).rows);
    expect(history[0]).toEqual({ amount: 290, months: 2, reference: "Bank transfer 1182" });
  });

  it("is closed to companies: Admins read their own billing and change nothing; drivers see none", async () => {
    for (const sql of [
      "select * from public.platform_billing()",
      "select public.platform_set_billing($1, 0, null)",
      "select public.platform_record_payment($1, 1)",
      "select * from public.platform_tenant_payments($1)",
      "update public.tenant_billing set monthly_fee = 0 where tenant_id = $1",
      "delete from public.tenant_payments where tenant_id = $1",
      "insert into public.tenant_payments (tenant_id, amount, paid_on) values ($1, 999, current_date)",
    ]) {
      await expectDenied(asUser(client, A.owner, (q) => q.query(sql, sql.includes("$1") ? [A.tenant] : [])));
    }
    const seen = (user: string) => asUser(client, user, async (q) => (await q.query("select tenant_id from public.tenant_billing")).rows.map((r) => r.tenant_id));
    expect(await seen(A.admin)).toEqual([A.tenant]);
    expect(await seen(A.driver1)).toEqual([]);
    expect(await seen(A.dispatcher)).toEqual([]);
  });
});

describe("deleting a company", () => {
  it("needs the platform, a suspended company and its web name; then removes every row", async () => {
    const del = (user: string, slug: string) => asUser(client, user, (q) => q.query("select public.platform_delete_tenant($1, $2)", [B.tenant, slug]), { commit: true });
    await expectDenied(del(B.owner, "tenant-b"));
    await expect(del(PLATFORM_ADMIN, "tenant-b")).rejects.toThrow(/Suspend the company/);
    await asUser(client, PLATFORM_ADMIN, (q) => q.query("select public.platform_set_tenant_status($1, 'suspended')", [B.tenant]), { commit: true });
    await expect(del(PLATFORM_ADMIN, "tenant-a")).rejects.toThrow(/does not match/);
    await del(PLATFORM_ADMIN, " Tenant-B ");
    const { rows } = await client.query("select table_name from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id'");
    for (const { table_name } of rows) {
      const left = (await client.query(`select count(*)::int as n from public.${table_name} where tenant_id = $1`, [B.tenant])).rows[0].n;
      expect({ table_name, left }).toEqual({ table_name, left: 0 });
    }
    expect((await client.query("select count(*)::int as n from public.tenants where id = $1", [A.tenant])).rows[0].n).toBe(1);
    // The people keep their sign-in accounts.
    expect((await client.query("select count(*)::int as n from auth.users where id = $1", [B.owner])).rows[0].n).toBe(1);
  });
});
