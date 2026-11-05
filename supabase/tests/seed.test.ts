import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDatabase } from "./helpers";

const NADERA = "10000000-0000-4000-8000-000000000001";
const DISPATCHER = "20000000-0000-4000-8000-000000000003";
const DRIVER1 = "20000000-0000-4000-8000-000000000004";
const DRIVER2 = "20000000-0000-4000-8000-000000000005";
const WESTERN_ADMIN = "20000000-0000-4000-8000-000000000011";

let db: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  db = await createTestDatabase({ seed: true });
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe("seed data", () => {
  it("loads Nadera Distributors and a second tenant, in Fiji time", async () => {
    const { rows } = await db.client.query("select slug, time_zone, billzilla_enabled from public.tenants order by slug");
    expect(rows).toEqual([
      { slug: "nadera", time_zone: "Pacific/Fiji", billzilla_enabled: true },
      { slug: "western-wholesale", time_zone: "Pacific/Fiji", billzilla_enabled: false },
    ]);
  });

  it("gives Nadera depots, vehicles, shops around Suva, Nabua, Samabula and Nausori, plus Taveuni and Lau", async () => {
    const { rows } = await db.client.query(
      `select
        (select count(*) from public.depots where tenant_id = $1)::int as depots,
        (select count(*) from public.vehicles where tenant_id = $1)::int as vehicles,
        (select count(*) from public.locations where tenant_id = $1 and type = 'shop' and status = 'approved')::int as shops,
        (select count(*) from public.locations where tenant_id = $1 and status = 'pending')::int as pending,
        (select count(*) from public.locations where tenant_id = $1 and extensions.st_x(point::extensions.geometry) < 0)::int as east_of_180`,
      [NADERA],
    );
    expect(rows[0]).toEqual({ depots: 2, vehicles: 4, shops: 17, pending: 2, east_of_180: 2 });
    const names = (await db.client.query("select string_agg(address, ' ') as a from public.locations where tenant_id = $1", [NADERA])).rows[0].a;
    for (const area of ["Suva", "Nabua", "Samabula", "Nausori"]) expect(names).toContain(area);
  });

  it("has invoices ready for delivery, and two whose customers still need a pin", async () => {
    const { rows } = await db.client.query(
      `select
        count(*) filter (where c.location_id is null)::int as needs_pin,
        count(*) filter (where c.location_id is not null and o.delivery_status = 'ready')::int as ready,
        count(*) filter (where o.delivery_status = 'planned')::int as planned
       from public.orders o join public.customers c on c.id = o.customer_id where o.tenant_id = $1`,
      [NADERA],
    );
    expect(rows[0]).toEqual({ needs_pin: 2, ready: 11, planned: 7 });
  });

  it("shows Jone today's sent route with four stops, and hides Salote's draft from her", async () => {
    const jone = await asUser(db.client, DRIVER1, async (q) => ({
      routes: (await q.query("select name from public.routes")).rows.map((r) => r.name),
      stops: Number((await q.query("select count(*) from public.route_stops")).rows[0].count),
    }));
    expect(jone).toEqual({ routes: ["Suva CBD and Toorak"], stops: 4 });
    const salote = await asUser(db.client, DRIVER2, async (q) => (await q.query("select count(*) from public.routes")).rows[0].count);
    expect(Number(salote)).toBe(0);
  });

  it("flags the pending Nabua pin as a likely duplicate of Nabua Family Store", async () => {
    const nearby = await asUser(db.client, DISPATCHER, async (q) =>
      (await q.query("select name, round(distance_m) as m from public.nearby_locations($1, 178.45905, -18.11812) where name <> 'Nabua Family Shop'", [NADERA])).rows,
    );
    expect(nearby.map((n) => n.name)).toEqual(["Nabua Family Store"]);
  });

  it("applies 50 km/h in Suva and 80 km/h on Kings Road between Nakasi and Nausori", async () => {
    const limits = await asUser(db.client, DRIVER1, async (q) => ({
      suva: (await q.query("select limit_kmh from public.speed_limit_at($1, 178.4258, -18.1398)", [NADERA])).rows[0].limit_kmh,
      kingsRoad: (await q.query("select limit_kmh from public.speed_limit_at($1, 178.5200, -18.0550)", [NADERA])).rows[0].limit_kmh,
    }));
    expect(limits).toEqual({ suva: 50, kingsRoad: 80 });
  });

  it("keeps the second tenant apart from Nadera", async () => {
    const seen = await asUser(db.client, WESTERN_ADMIN, async (q) => Number((await q.query("select count(*) from public.locations where tenant_id = $1", [NADERA])).rows[0].count));
    expect(seen).toBe(0);
  });
});
