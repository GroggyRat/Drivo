import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, createTestDatabase, expectDenied } from "./helpers";
import { A, B, loadFixture } from "./fixtures";

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

// Shop one in the fixture is at (178.4519, -18.1416). One degree of latitude
// is about 110.6 km, so 0.00018 degrees is about 20 m.
const SHOP1 = { lon: 178.4519, lat: -18.1416 };
const metresNorth = (m: number) => SHOP1.lat + m / 110_600;

const submit = (q: pg.Client, tenant: string, name: string, lat: number, extra: { type?: string; accuracy?: number; expires?: string } = {}) =>
  q.query(
    "select public.submit_location($1, $2, $3::public.location_type, $4, $5, $6, 'Next to the church', null, null, $7::timestamptz) as r",
    [tenant, name, extra.type ?? "shop", SHOP1.lon, lat, extra.accuracy ?? 8, extra.expires ?? null],
  ).then((res) => res.rows[0].r as { id: string; status: string; nearby: { id: string; distance_m: number }[] });

describe("dropping a pin", () => {
  it("a driver's pin waits for review; an Admin's is approved at once", async () => {
    const driver = await asUser(client, A.driver1, (q) => submit(q, A.tenant, "New shop", metresNorth(500)));
    const admin = await asUser(client, A.admin, (q) => submit(q, A.tenant, "New shop", metresNorth(500)));
    expect(driver.status).toBe("pending");
    expect(admin.status).toBe("approved");
  });

  it("warns about locations within 30 m, with the distance, and not beyond", async () => {
    const near = await asUser(client, A.driver1, (q) => submit(q, A.tenant, "Close by", metresNorth(20)));
    expect(near.nearby.map((n) => n.id)).toEqual([A.shop1]);
    expect(near.nearby[0].distance_m).toBeGreaterThan(18);
    expect(near.nearby[0].distance_m).toBeLessThan(22);

    const far = await asUser(client, A.driver1, (q) => submit(q, A.tenant, "Further", metresNorth(40)));
    expect(far.nearby).toEqual([]);
  });

  it("does not tell a driver about another driver's pending pin nearby", async () => {
    // pinByDriver2 is at lon + 0.04 from the centre, i.e. 178.4819.
    const result = await asUser(client, A.driver1, (q) =>
      q.query("select public.submit_location($1, 'X', 'shop', 178.4819, -18.1416, 5) as r", [A.tenant]).then((r) => r.rows[0].r),
    );
    expect(result.nearby).toEqual([]);
    const forAdmin = await asUser(client, A.admin, (q) =>
      q.query("select public.submit_location($1, 'X', 'shop', 178.4819, -18.1416, 5) as r", [A.tenant]).then((r) => r.rows[0].r),
    );
    expect(forAdmin.nearby.map((n: { id: string }) => n.id)).toEqual([A.pinByDriver2]);
  });

  it("refuses a fix worse than 30 m, a point off the globe, and expiry on anything but a hazard", async () => {
    await expect(asUser(client, A.driver1, (q) => submit(q, A.tenant, "Blurry", metresNorth(500), { accuracy: 45 }))).rejects.toThrow(/30 m/);
    await expect(
      asUser(client, A.driver1, (q) => q.query("select public.submit_location($1, 'X', 'shop', 181, -18, 5)", [A.tenant])),
    ).rejects.toThrow(/Longitude/);
    await expect(
      asUser(client, A.driver1, (q) => submit(q, A.tenant, "Shop", metresNorth(500), { expires: "2099-01-01" })),
    ).rejects.toMatchObject({ code: "23514" });
    const hazard = await asUser(client, A.driver1, (q) =>
      submit(q, A.tenant, "Flooded ford", metresNorth(900), { type: "hazard", expires: "2099-01-01" }),
    );
    expect(hazard.status).toBe("pending");
  });

  it("cannot drop a pin in a tenant you are not in", async () => {
    await expectDenied(asUser(client, A.driver1, (q) => submit(q, B.tenant, "Sneaky", metresNorth(500))));
  });

  it("nearby_locations respects what the caller may see", async () => {
    const forDriver = await asUser(client, A.driver1, async (q) =>
      (await q.query("select id from public.nearby_locations($1, 178.4419, -18.1416, 6000)", [A.tenant])).rows.map((r) => r.id),
    );
    expect(forDriver).not.toContain(A.pinByDriver2);
    expect(forDriver).toContain(A.pinByDriver1);
    const crossTenant = await asUser(client, A.admin, async (q) =>
      (await q.query("select id from public.nearby_locations($1, 177.4503, -17.6088, 6000)", [B.tenant])).rows,
    );
    expect(crossTenant).toEqual([]);
  });
});

describe("reviewing pins", () => {
  it("an Admin approves a pin and links customers to it in one step", async () => {
    const result = await asUser(client, A.admin, async (q) => {
      const loc = (await q.query("select * from public.review_location($1, true, null, $2)", [A.pinByDriver1, [A.customerNoLocation]])).rows[0];
      const customer = (await q.query("select location_id from public.customers where id = $1", [A.customerNoLocation])).rows[0];
      return { status: loc.status, approvedBy: loc.approved_by, linked: customer.location_id };
    });
    expect(result).toEqual({ status: "approved", approvedBy: A.admin, linked: A.pinByDriver1 });
  });

  it("an Admin rejects with a reason", async () => {
    const loc = await asUser(client, A.admin, async (q) =>
      (await q.query("select * from public.review_location($1, false, 'Duplicate of Shop two')", [A.pinByDriver2])).rows[0],
    );
    expect(loc).toMatchObject({ status: "rejected", rejected_by: A.admin, rejected_reason: "Duplicate of Shop two" });
  });

  it("cannot reject a location customers deliver to", async () => {
    await expect(
      asUser(client, A.admin, (q) => q.query("select public.review_location($1, false, 'No')", [A.shop1])),
    ).rejects.toThrow(/Customers are linked/);
  });

  it("dispatchers and drivers can view the queue but not approve; other tenants cannot touch it", async () => {
    await expectDenied(asUser(client, A.dispatcher, (q) => q.query("select public.review_location($1, true)", [A.pinByDriver1])));
    await expectDenied(asUser(client, A.driver1, (q) => q.query("select public.review_location($1, true)", [A.pinByDriver1])));
    await expectDenied(asUser(client, B.admin, (q) => q.query("select public.review_location($1, true)", [A.pinByDriver1])));
  });

  it("an Admin cannot link another tenant's customer while approving", async () => {
    await expect(
      asUser(client, A.admin, (q) => q.query("select public.review_location($1, true, null, $2)", [A.pinByDriver1, [B.customerLinked]])),
    ).rejects.toThrow(/Customer not found/);
  });

  it("an Admin edits a location; a dispatcher cannot", async () => {
    const loc = await asUser(client, A.admin, async (q) =>
      (await q.query("select name from public.update_location($1, p_name => 'Shop one (rear entrance)')", [A.shop1])).rows[0],
    );
    expect(loc.name).toBe("Shop one (rear entrance)");
    await expectDenied(asUser(client, A.dispatcher, (q) => q.query("select public.update_location($1, p_name => 'X')", [A.shop1])));
  });
});

describe("customers and stops", () => {
  it("a customer can only be linked to an approved shop", async () => {
    await expect(
      asUser(client, A.dispatcher, (q) => q.query("update public.customers set location_id = $2 where id = $1", [A.customerNoLocation, A.pinByDriver2])),
    ).rejects.toThrow(/approved shop/);
  });

  it("one location can serve several customers", async () => {
    await asUser(client, A.dispatcher, (q) =>
      q.query("insert into public.customers (tenant_id, name, location_id) values ($1, 'Second account, same shop', $2)", [A.tenant, A.shop1]),
    );
  });

  it("an order whose customer has no location cannot be added to a route", async () => {
    await expect(
      asUser(client, A.dispatcher, (q) =>
        q.query("insert into public.route_stops (tenant_id, route_id, sequence, location_id, order_id) values ($1, $2, 2, $3, $4)", [
          A.tenant, A.draftRoute, A.shop1, A.orderNoLocation,
        ]),
      ),
    ).rejects.toThrow(/no location yet/);
  });

  it("the stop must be at the customer's location, and at an approved, non-hazard location", async () => {
    await expect(
      asUser(client, A.dispatcher, (q) =>
        q.query("insert into public.route_stops (tenant_id, route_id, sequence, location_id, order_id) values ($1, $2, 2, $3, $4)", [
          A.tenant, A.draftRoute, A.shop2, A.orderUnrouted,
        ]),
      ),
    ).rejects.toThrow(/customer's location/);
    await expect(
      asUser(client, A.dispatcher, (q) =>
        q.query("insert into public.route_stops (tenant_id, route_id, sequence, location_id) values ($1, $2, 2, $3)", [
          A.tenant, A.draftRoute, A.pinByDriver1,
        ]),
      ),
    ).rejects.toThrow(/approved location/);
    await asUser(client, A.dispatcher, (q) =>
      q.query("insert into public.route_stops (tenant_id, route_id, sequence, location_id, order_id) values ($1, $2, 2, $3, $4)", [
        A.tenant, A.draftRoute, A.shop1, A.orderUnrouted,
      ]),
    );
  });

  it("a stop cannot point at another tenant's location", async () => {
    await expect(
      asUser(client, A.dispatcher, (q) =>
        q.query("insert into public.route_stops (tenant_id, route_id, sequence, location_id) values ($1, $2, 2, $3)", [
          A.tenant, A.draftRoute, B.shop1,
        ]),
      ),
    ).rejects.toThrow(/approved location/);
  });

  it("stops can be reordered by swapping sequences in one transaction", async () => {
    await asUser(client, A.dispatcher, async (q) => {
      const second = (await q.query(
        "insert into public.route_stops (tenant_id, route_id, sequence, location_id) values ($1, $2, 2, $3) returning id",
        [A.tenant, A.draftRoute, A.shop1],
      )).rows[0].id;
      await q.query("set constraints route_stops_sequence deferred");
      await q.query("update public.route_stops set sequence = 1 where id = $1", [second]);
      await q.query("update public.route_stops set sequence = 2 where id = $1", [A.draftStop]);
    });
  });

  it("a route cannot be sent without a driver and a vehicle", async () => {
    await expect(
      asUser(client, A.dispatcher, (q) => q.query("update public.routes set status = 'sent' where id = $1", [A.draftRoute])),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("speed limits and alerts", () => {
  it("uses the urban limit inside a town zone and the highway limit outside", async () => {
    const limits = await asUser(client, A.driver1, async (q) => ({
      town: (await q.query("select * from public.speed_limit_at($1, 178.4419, -18.1416)", [A.tenant])).rows[0],
      highway: (await q.query("select * from public.speed_limit_at($1, 178.60, -18.00)", [A.tenant])).rows[0],
    }));
    expect(limits).toEqual({ town: { limit_kmh: 50, zone_name: "Town" }, highway: { limit_kmh: 80, zone_name: null } });
  });

  it("a zone's own limit wins, the lowest when zones overlap, and tenant settings change the defaults", async () => {
    await client.query(`
      insert into public.speed_zones (tenant_id, name, limit_kmh, area) values
        ('${A.tenant}', 'School', 30, extensions.st_multi(extensions.st_makeenvelope(178.44, -18.143, 178.444, -18.14, 4326))::extensions.geography)`);
    await client.query("update public.tenant_settings set highway_speed_limit_kmh = 70 where tenant_id = $1", [A.tenant]);
    const limits = await asUser(client, A.driver1, async (q) => ({
      school: (await q.query("select * from public.speed_limit_at($1, 178.4419, -18.1416)", [A.tenant])).rows[0],
      highway: (await q.query("select * from public.speed_limit_at($1, 178.60, -18.00)", [A.tenant])).rows[0],
    }));
    expect(limits).toEqual({ school: { limit_kmh: 30, zone_name: "School" }, highway: { limit_kmh: 70, zone_name: null } });
  });

  it("other tenants cannot read a tenant's limits", async () => {
    await expectDenied(asUser(client, B.driver1, (q) => q.query("select * from public.speed_limit_at($1, 178.44, -18.14)", [A.tenant])));
  });

  it("a dispatcher acknowledges a speed alert once; drivers and other tenants cannot", async () => {
    await expectDenied(asUser(client, A.driver1, (q) => q.query("select public.acknowledge_speed_event($1)", [A.speedEvent])));
    await expectDenied(asUser(client, B.admin, (q) => q.query("select public.acknowledge_speed_event($1)", [A.speedEvent])));
    const event = await asUser(
      client,
      A.dispatcher,
      async (q) => (await q.query("select * from public.acknowledge_speed_event($1)", [A.speedEvent])).rows[0],
      { commit: true },
    );
    expect(event.acknowledged_by).toBe(A.dispatcher);
    const again = await asUser(client, A.admin, async (q) => (await q.query("select * from public.acknowledge_speed_event($1)", [A.speedEvent])).rows[0]);
    expect(again.acknowledged_by).toBe(A.dispatcher);
  });
});
