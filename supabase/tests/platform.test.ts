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
      ["billzilla_linked", "created_at", "drivers", "id", "kaiworkforce_linked", "name", "people", "routes_last_30_days", "slug", "status", "vehicles"],
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
