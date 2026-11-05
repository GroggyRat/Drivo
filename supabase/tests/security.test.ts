import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asAnon, asUser, count, createTestDatabase, expectDenied, publicTables } from "./helpers";
import { A, B, PLATFORM_ADMIN, STRANGER, loadFixture, tenantColumn } from "./fixtures";

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

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

async function tenantTables() {
  return (await publicTables(client)).filter((t) => t !== "platform_admins");
}

/** How many rows of `tenant` the user can see in each table, keeping only non-zero counts. */
async function visibleRows(userId: string, tenant: string) {
  const tables = await tenantTables();
  return asUser(client, userId, async (q) => {
    const seen: Record<string, number> = {};
    for (const table of tables) {
      const n = await count(q, `select count(*) from public.${table} where ${tenantColumn(table)} = $1`, [tenant]);
      if (n > 0) seen[table] = n;
    }
    return seen;
  });
}

describe("every table", () => {
  it("has row level security enabled", async () => {
    const { rows } = await client.query(
      "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity",
    );
    expect(rows).toEqual([]);
  });

  it("has a tenant_id column, apart from tenants and platform_admins", async () => {
    const { rows } = await client.query(
      "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id'",
    );
    const withTenant = new Set(rows.map((r) => r.table_name));
    const missing = (await publicTables(client)).filter((t) => !["tenants", "platform_admins"].includes(t) && !withTenant.has(t));
    expect(missing).toEqual([]);
  });

  it("is closed to anonymous visitors", async () => {
    for (const table of await publicTables(client)) {
      await expectDenied(asAnon(client, (q) => q.query(`select 1 from public.${table} limit 1`)));
    }
  });
});

describe("tenant isolation", () => {
  const people = (t: typeof A) => [t.owner, t.admin, t.dispatcher, t.driver1, t.driver2];

  it("no one in tenant A sees a single tenant B row, in any table", async () => {
    for (const user of people(A)) {
      expect({ user, seen: await visibleRows(user, B.tenant) }).toEqual({ user, seen: {} });
    }
  });

  it("no one in tenant B sees a single tenant A row, in any table", async () => {
    for (const user of people(B)) {
      expect({ user, seen: await visibleRows(user, A.tenant) }).toEqual({ user, seen: {} });
    }
  });

  it("a signed-in person with no membership sees nothing", async () => {
    expect(await visibleRows(STRANGER, A.tenant)).toEqual({});
    expect(await visibleRows(STRANGER, B.tenant)).toEqual({});
  });

  it("a platform admin sees no tenant rows through the tables", async () => {
    expect(await visibleRows(PLATFORM_ADMIN, A.tenant)).toEqual({});
  });

  it("an admin of A reaches every A table they should (the test is not passing vacuously)", async () => {
    const seen = await visibleRows(A.admin, A.tenant);
    for (const table of await tenantTables()) {
      expect({ table, visible: (seen[table] ?? 0) > 0 }).toEqual({ table, visible: true });
    }
  });

  it("an admin of A cannot write rows into tenant B", async () => {
    await expectDenied(
      asUser(client, A.admin, (q) =>
        q.query(
          "insert into public.depots (tenant_id, name, point) values ($1, 'Sneaky', extensions.st_makepoint(178.4, -18.1)::extensions.geography)",
          [B.tenant],
        ),
      ),
    );
    await expectDenied(
      asUser(client, A.admin, (q) =>
        q.query("insert into public.customers (tenant_id, name) values ($1, 'Sneaky')", [B.tenant]),
      ),
    );
  });

  it("an admin of A cannot change or delete tenant B rows", async () => {
    const result = await asUser(client, A.admin, async (q) => {
      const updated = await q.query("update public.vehicles set model = 'Changed' where tenant_id = $1", [B.tenant]);
      const deleted = await q.query("delete from public.depots where tenant_id = $1", [B.tenant]);
      const settings = await q.query("update public.tenant_settings set urban_speed_limit_kmh = 20 where tenant_id = $1", [B.tenant]);
      return [updated.rowCount, deleted.rowCount, settings.rowCount];
    });
    expect(result).toEqual([0, 0, 0]);
  });

  it("composite foreign keys stop a row pointing at another tenant's row, even for the database owner", async () => {
    await expect(
      client.query(
        "insert into public.proofs_of_delivery (tenant_id, stop_id, delivered_in_full, captured_by, captured_at) values ($1, $2, true, $3, now())",
        [A.tenant, B.draftStop, A.driver1],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        "insert into public.routes (tenant_id, route_date, depot_id, created_by) values ($1, current_date, $2, $3)",
        [A.tenant, B.depot, A.dispatcher],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query("insert into public.orders (tenant_id, reference, customer_id, customer_name) values ($1, 'X-1', $2, 'X')", [A.tenant, B.customerLinked]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("files: members read only their tenant's folders and cannot upload into another tenant's", async () => {
    const names = await asUser(client, A.driver1, async (q) =>
      (await q.query("select name from storage.objects order by name")).rows.map((r) => r.name as string),
    );
    expect(names.length).toBe(2);
    expect(names.every((n) => n.startsWith(`${A.tenant}/`))).toBe(true);

    await asUser(client, A.driver1, (q) =>
      q.query("insert into storage.objects (bucket_id, name) values ('delivery-proofs', $1)", [`${A.tenant}/new/photo.jpg`]),
    );
    await expectDenied(
      asUser(client, A.driver1, (q) =>
        q.query("insert into storage.objects (bucket_id, name) values ('delivery-proofs', $1)", [`${B.tenant}/new/photo.jpg`]),
      ),
    );
  });
});

describe("suspended tenants", () => {
  it("staff of a suspended tenant see nothing; other tenants are unaffected; reactivating restores access", async () => {
    await client.query("update public.tenants set status = 'suspended', suspended_at = now() where id = $1", [A.tenant]);
    try {
      expect(await visibleRows(A.owner, A.tenant)).toEqual({});
      expect(await visibleRows(A.driver1, A.tenant)).toEqual({});
      expect(Object.keys(await visibleRows(B.owner, B.tenant)).length).toBeGreaterThan(5);
      await expectDenied(
        asUser(client, A.driver1, (q) =>
          q.query(
            "insert into public.gps_batches (id, tenant_id, driver_id, recorded_from, recorded_to, point_count, points) values (gen_random_uuid(), $1, $2, now(), now(), 1, '[]')",
            [A.tenant, A.driver1],
          ),
        ),
      );
    } finally {
      await client.query("update public.tenants set status = 'active', suspended_at = null where id = $1", [A.tenant]);
    }
    expect(Object.keys(await visibleRows(A.owner, A.tenant)).length).toBeGreaterThan(5);
  });

  it("a deactivated person sees nothing", async () => {
    await client.query("update public.memberships set active = false where user_id = $1", [A.dispatcher]);
    try {
      expect(await visibleRows(A.dispatcher, A.tenant)).toEqual({});
    } finally {
      await client.query("update public.memberships set active = true where user_id = $1", [A.dispatcher]);
    }
  });
});

describe("drivers", () => {
  it("see only routes sent to them, never drafts or other drivers' routes", async () => {
    const d1 = await asUser(client, A.driver1, async (q) => ids((await q.query("select id from public.routes")).rows));
    const d2 = await asUser(client, A.driver2, async (q) => ids((await q.query("select id from public.routes")).rows));
    expect(d1).toEqual([A.sentRoute]);
    // driver2's route is still a draft.
    expect(d2).toEqual([]);
  });

  it("see the stops, orders, customers and proofs on their routes, and nothing else", async () => {
    const seen = await asUser(client, A.driver1, async (q) => ({
      stops: ids((await q.query("select id from public.route_stops")).rows),
      orders: ids((await q.query("select id from public.orders")).rows),
      customers: ids((await q.query("select id from public.customers")).rows),
      proofs: ids((await q.query("select id from public.proofs_of_delivery")).rows),
    }));
    expect(seen).toEqual({ stops: [A.sentStop], orders: [A.orderLinked], customers: [A.customerLinked], proofs: [A.proof] });
  });

  it("see approved locations and their own pins, not other drivers' pins or expired hazards", async () => {
    const d1 = await asUser(client, A.driver1, async (q) => ids((await q.query("select id from public.locations")).rows));
    expect(d1).toEqual([A.shop1, A.shop2, A.pinByDriver1].sort());
    const manager = await asUser(client, A.dispatcher, async (q) => ids((await q.query("select id from public.locations")).rows));
    expect(manager).toEqual([A.shop1, A.shop2, A.pinByDriver1, A.pinByDriver2, A.expiredHazard].sort());
  });

  it("see only their own membership, shifts, trips and speed events", async () => {
    const d1 = await asUser(client, A.driver1, async (q) => ({
      people: (await q.query("select user_id from public.memberships")).rows.map((r) => r.user_id),
      shifts: await count(q, "select count(*) from public.shifts"),
      trips: await count(q, "select count(*) from public.trips"),
      speedEvents: await count(q, "select count(*) from public.speed_events"),
      batches: await count(q, "select count(*) from public.gps_batches"),
      segmentSpeeds: await count(q, "select count(*) from public.segment_speeds"),
    }));
    expect(d1).toEqual({ people: [A.driver1], shifts: 1, trips: 1, speedEvents: 1, batches: 1, segmentSpeeds: 0 });
    const d2 = await asUser(client, A.driver2, async (q) => count(q, "select count(*) from public.speed_events"));
    expect(d2).toBe(0);
  });

  it("cannot write locations, routes, stops, orders or proofs directly", async () => {
    const attempts = [
      "insert into public.locations (tenant_id, name, type, point, created_by) values ($1, 'X', 'shop', extensions.st_makepoint(178.4, -18.1)::extensions.geography, $2)",
      "insert into public.routes (tenant_id, route_date, depot_id, created_by) values ($1, current_date, '" + A.depot + "', $2)",
      "insert into public.orders (tenant_id, reference, customer_id, customer_name) values ($1, 'D-1', '" + A.customerLinked + "', $2)",
      "insert into public.proofs_of_delivery (tenant_id, stop_id, delivered_in_full, captured_by, captured_at) values ($1, '" + A.draftStop + "', true, $2, now())",
    ];
    for (const sql of attempts) {
      await expectDenied(asUser(client, A.driver1, (q) => q.query(sql, [A.tenant, A.driver1])));
    }
    const changed = await asUser(client, A.driver1, async (q) =>
      (await q.query("update public.route_stops set status = 'delivered' where id = $1", [A.sentStop])).rowCount,
    );
    expect(changed).toBe(0);
  });

  it("upload their own GPS batches, but not as another driver or against another driver's shift", async () => {
    const insert = (q: pg.Client, driver: string, shift: string | null) =>
      q.query(
        "insert into public.gps_batches (id, tenant_id, driver_id, shift_id, recorded_from, recorded_to, point_count, points) values (gen_random_uuid(), $1, $2, $3, now(), now(), 1, '[[0, 178.44, -18.14, 5, 0, 0]]')",
        [A.tenant, driver, shift],
      );
    await asUser(client, A.driver1, (q) => insert(q, A.driver1, A.shift));
    await expectDenied(asUser(client, A.driver1, (q) => insert(q, A.driver2, null)));
    await expectDenied(asUser(client, A.driver2, (q) => insert(q, A.driver2, A.shift)));
    // Managers do not upload points.
    await expectDenied(asUser(client, A.dispatcher, (q) => insert(q, A.dispatcher, null)));
  });
});

describe("dispatchers", () => {
  it("cannot change vehicles, depots, speed zones or settings", async () => {
    await expectDenied(
      asUser(client, A.dispatcher, (q) =>
        q.query("insert into public.vehicles (tenant_id, plate, fuel_l_per_100km) values ($1, 'ZZ 999', 10)", [A.tenant]),
      ),
    );
    const changed = await asUser(client, A.dispatcher, async (q) => [
      (await q.query("update public.vehicles set model = 'X' where tenant_id = $1", [A.tenant])).rowCount,
      (await q.query("update public.tenant_settings set fuel_price_per_l = 1 where tenant_id = $1", [A.tenant])).rowCount,
      (await q.query("delete from public.speed_zones where tenant_id = $1", [A.tenant])).rowCount,
    ]);
    expect(changed).toEqual([0, 0, 0]);
  });

  it("plan routes, and can delete a draft but not a sent route", async () => {
    const result = await asUser(client, A.dispatcher, async (q) => {
      await q.query(
        "insert into public.routes (tenant_id, route_date, depot_id, created_by) values ($1, current_date, $2, $3)",
        [A.tenant, A.depot, A.dispatcher],
      );
      return [
        (await q.query("delete from public.routes where id = $1", [A.sentRoute])).rowCount,
        (await q.query("delete from public.routes where id = $1", [A.draftRoute])).rowCount,
      ];
    });
    expect(result).toEqual([0, 1]);
  });

  it("add manual orders but cannot create or edit BillZilla ones", async () => {
    await asUser(client, A.dispatcher, (q) =>
      q.query(
        "insert into public.orders (tenant_id, source, reference, customer_id, customer_name) values ($1, 'manual', 'M-100', $2, 'Linked customer')",
        [A.tenant, A.customerLinked],
      ),
    );
    await expectDenied(
      asUser(client, A.dispatcher, (q) =>
        q.query(
          "insert into public.orders (tenant_id, source, billzilla_invoice_id, reference, customer_id, customer_name) values ($1, 'billzilla', 'FAKE', 'F-1', $2, 'X')",
          [A.tenant, A.customerLinked],
        ),
      ),
    );
    const edited = await asUser(client, A.dispatcher, async (q) =>
      (await q.query("update public.orders set cartons = 99 where id = $1", [A.orderLinked])).rowCount,
    );
    expect(edited).toBe(0);
  });

  it("cannot rename a BillZilla customer, but can move it to another approved shop", async () => {
    await expectDenied(
      asUser(client, A.dispatcher, (q) => q.query("update public.customers set name = 'Renamed' where id = $1", [A.customerLinked])),
    );
    const moved = await asUser(client, A.dispatcher, async (q) =>
      (await q.query("update public.customers set location_id = $2 where id = $1", [A.customerLinked, A.shop2])).rowCount,
    );
    expect(moved).toBe(1);
  });
});

describe("people and tenant settings", () => {
  it("an Admin can change a driver's role but not the Owner's, and not their own", async () => {
    const promoted = await asUser(client, A.admin, async (q) =>
      (await q.query("update public.memberships set role = 'dispatcher' where user_id = $1 and tenant_id = $2", [A.driver2, A.tenant])).rowCount,
    );
    expect(promoted).toBe(1);
    await expectDenied(
      asUser(client, A.admin, (q) =>
        q.query("update public.memberships set active = false where user_id = $1 and tenant_id = $2", [A.owner, A.tenant]),
      ),
    );
    await expectDenied(
      asUser(client, A.admin, (q) =>
        q.query("update public.memberships set role = 'owner' where user_id = $1 and tenant_id = $2", [A.driver2, A.tenant]),
      ),
    );
    await expectDenied(
      asUser(client, A.admin, (q) =>
        q.query("update public.memberships set role = 'driver' where user_id = $1 and tenant_id = $2", [A.admin, A.tenant]),
      ),
    );
  });

  it("people cannot add memberships themselves", async () => {
    await expectDenied(
      asUser(client, A.owner, (q) =>
        q.query("insert into public.memberships (tenant_id, user_id, role, full_name) values ($1, $2, 'admin', 'X')", [A.tenant, STRANGER]),
      ),
    );
  });

  it("Admins edit tenant details but not status, slug or the integration ids webhooks rely on", async () => {
    const renamed = await asUser(client, A.admin, async (q) =>
      (await q.query("update public.tenants set name = 'Renamed', billzilla_enabled = true where id = $1", [A.tenant])).rowCount,
    );
    expect(renamed).toBe(1);
    for (const sql of [
      "update public.tenants set status = 'active' where id = $1",
      "update public.tenants set slug = 'stolen' where id = $1",
      "update public.tenants set billzilla_org_id = 'someone-else' where id = $1",
      "update public.tenants set kaiworkforce_company_id = 'someone-else' where id = $1",
    ]) {
      await expectDenied(asUser(client, A.admin, (q) => q.query(sql, [A.tenant])));
    }
  });
});
