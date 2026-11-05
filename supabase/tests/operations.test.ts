import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asService, asUser, count, createTestDatabase, expectDenied } from "./helpers";
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

const route = (stops: { location_id: string; order_id?: string }[], extra: Record<string, unknown> = {}) => ({
  name: "Test run",
  route_date: "2026-11-06",
  depot_id: A.depot,
  optimise_for: "fastest",
  driver_id: A.driver2,
  vehicle_id: A.vehicle,
  planned_distance_m: 12000,
  planned_duration_s: 3000,
  fuel_estimate_l: 1.9,
  geometry: { type: "LineString", coordinates: [[178.4419, -18.1416], [178.4519, -18.1416]] },
  stops,
  ...extra,
});

const save = (userId: string, body: unknown, commit = true) =>
  asUser(client, userId, async (q) => (await q.query("select public.save_route($1, $2) as id", [A.tenant, body])).rows[0].id as string, { commit });

const orderStatus = async (id: string) => (await client.query("select delivery_status from public.orders where id = $1", [id])).rows[0].delivery_status;

describe("planning routes", () => {
  it("a dispatcher saves a draft with stops, and its orders become planned", async () => {
    const id = await save(A.dispatcher, route([{ location_id: A.shop1, order_id: A.orderUnrouted }, { location_id: A.shop2 }]));
    const stops = (await client.query("select sequence, location_id from public.route_stops where route_id = $1 order by sequence", [id])).rows;
    expect(stops).toEqual([{ sequence: 1, location_id: A.shop1 }, { sequence: 2, location_id: A.shop2 }]);
    expect(await orderStatus(A.orderUnrouted)).toBe("planned");
    const r = (await client.query("select status, round(extensions.st_length(geometry)) as m from public.routes where id = $1", [id])).rows[0];
    expect(r.status).toBe("draft");
    expect(Number(r.m)).toBeGreaterThan(1000);

    // Saving again without the order puts it back to ready.
    await save(A.dispatcher, route([{ location_id: A.shop2 }], { id }));
    expect(await orderStatus(A.orderUnrouted)).toBe("ready");
    await asUser(client, A.dispatcher, (q) => q.query("delete from public.routes where id = $1", [id]), { commit: true });
  });

  it("refuses an order already on another active route, and one whose customer has no pin", async () => {
    await expect(save(A.dispatcher, route([{ location_id: A.shop1, order_id: A.orderLinked }]), false)).rejects.toThrow(/another route/);
    await expect(save(A.dispatcher, route([{ location_id: A.shop1, order_id: A.orderNoLocation }]), false)).rejects.toThrow(/no location yet/);
  });

  it("refuses drivers, other tenants and a driver who is not a driver", async () => {
    await expectDenied(save(A.driver1, route([{ location_id: A.shop1 }]), false));
    await expectDenied(save(B.dispatcher, route([{ location_id: A.shop1 }]), false));
    await expect(save(A.dispatcher, route([{ location_id: A.shop1 }], { driver_id: A.admin }), false)).rejects.toThrow(/not an active driver/);
  });

  it("only drafts can be changed; sending needs a driver and a vehicle", async () => {
    await expect(save(A.dispatcher, route([{ location_id: A.shop1 }], { id: A.sentRoute }), false)).rejects.toThrow(/Only draft/);
    const id = await save(A.dispatcher, route([{ location_id: A.shop1 }], { vehicle_id: null }));
    await expect(asUser(client, A.dispatcher, (q) => q.query("select public.send_route($1)", [id]))).rejects.toThrow(/driver and a vehicle/);
    await asUser(client, A.dispatcher, (q) => q.query("delete from public.routes where id = $1", [id]), { commit: true });
  });
});

describe("a driver's day", () => {
  let routeId: string;
  let stop1: string;
  let stop2: string;

  beforeAll(async () => {
    routeId = await save(A.dispatcher, route([{ location_id: A.shop1, order_id: A.orderUnrouted }, { location_id: A.shop2 }]));
    await asUser(client, A.dispatcher, (q) => q.query("select public.send_route($1)", [routeId]), { commit: true });
    const stops = (await client.query("select id from public.route_stops where route_id = $1 order by sequence", [routeId])).rows;
    [stop1, stop2] = stops.map((s) => s.id);
  });

  it("the driver sees the sent route; others cannot start it", async () => {
    const seen = await asUser(client, A.driver2, async (q) => count(q, "select count(*) from public.routes where id = $1", [routeId]));
    expect(seen).toBe(1);
    await expectDenied(asUser(client, A.driver1, (q) => q.query("select public.start_route($1)", [routeId])));
  });

  it("stops cannot be completed before the route starts", async () => {
    await expect(
      asUser(client, A.driver2, (q) => q.query("select public.complete_stop($1, $2)", [stop1, { outcome: "delivered", received_by: "X" }])),
    ).rejects.toThrow(/Start the route/);
  });

  it("starting the route marks orders out for delivery and, without KaiWorkforce, opens a tracking shift", async () => {
    const result = await asUser(client, A.driver2, async (q) => (await q.query("select public.start_route($1) as r", [routeId])).rows[0].r, { commit: true });
    expect(result).toMatchObject({ status: "in_progress", tracking: true });
    expect(await orderStatus(A.orderUnrouted)).toBe("out_for_delivery");
    const shift = (await client.query("select source, route_id from public.shifts where driver_id = $1 and ended_at is null", [A.driver2])).rows[0];
    expect(shift).toEqual({ source: "route", route_id: routeId });
  });

  it("arriving reports the distance from the pin", async () => {
    const r = await asUser(client, A.driver2, async (q) =>
      (await q.query("select public.arrive_stop($1, 178.4519, -18.1418) as r", [stop1])).rows[0].r, { commit: true });
    expect(r.status).toBe("arrived");
    expect(Number(r.distance_m)).toBeGreaterThan(15);
    expect(Number(r.distance_m)).toBeLessThan(30);
  });

  it("a partial delivery needs notes, and a delivery needs who received it", async () => {
    await expect(
      asUser(client, A.driver2, (q) => q.query("select public.complete_stop($1, $2)", [stop1, { outcome: "partially_delivered", received_by: "Ana" }])),
    ).rejects.toThrow(/Say what happened/);
    await expect(
      asUser(client, A.driver2, (q) => q.query("select public.complete_stop($1, $2)", [stop1, { outcome: "delivered" }])),
    ).rejects.toThrow(/who received/);
  });

  it("completing a BillZilla delivery records proof, updates the order and queues the update for BillZilla", async () => {
    const proofId = "c0000000-0000-4000-8000-000000000001";
    const proof = {
      id: proofId, outcome: "delivered", received_by: "Ana Tora", photo_path: `${A.tenant}/${stop1}/photo.jpg`,
      signature_path: `${A.tenant}/${stop1}/signature.png`, lon: 178.4519, lat: -18.1416, accuracy_m: 6,
    };
    const r = await asUser(client, A.driver2, async (q) => (await q.query("select public.complete_stop($1, $2) as r", [stop1, proof])).rows[0].r, { commit: true });
    expect(r).toMatchObject({ status: "delivered", route_status: "in_progress", duplicate: false });
    expect(await orderStatus(A.orderUnrouted)).toBe("delivered");
    const outbox = (await client.query("select payload from public.integration_outbox where target_id = 'BZ-I-a3'")).rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload).toMatchObject({ status: "delivered", received_by: "Ana Tora", driver_name: "Tenant A driver2", vehicle_plate: "AA 101" });

    // The phone retries after losing signal: nothing changes.
    const again = await asUser(client, A.driver2, async (q) => (await q.query("select public.complete_stop($1, $2) as r", [stop1, proof])).rows[0].r, { commit: true });
    expect(again.duplicate).toBe(true);
    expect(await count(client, "select count(*) from public.integration_outbox where target_id = 'BZ-I-a3'")).toBe(1);
  });

  it("another driver cannot complete the stop", async () => {
    await expectDenied(
      asUser(client, A.driver1, (q) => q.query("select public.complete_stop($1, $2)", [stop2, { outcome: "failed", partial_notes: "Closed" }])),
    );
  });

  it("the last stop completes the route and stops route tracking", async () => {
    const r = await asUser(client, A.driver2, async (q) =>
      (await q.query("select public.complete_stop($1, $2) as r", [stop2, { outcome: "failed", partial_notes: "Shop closed" }])).rows[0].r, { commit: true });
    expect(r).toMatchObject({ status: "failed", route_status: "completed" });
    expect(await count(client, "select count(*) from public.shifts where driver_id = $1 and ended_at is null", [A.driver2])).toBe(0);
    const stop = (await client.query("select status, failure_reason from public.route_stops where id = $1", [stop2])).rows[0];
    expect(stop).toEqual({ status: "failed", failure_reason: "Shop closed" });
  });
});

describe("cancelling a route", () => {
  it("puts undelivered orders back to ready and skips the stops", async () => {
    await client.query("update public.orders set delivery_status = 'ready' where id = $1", [A.orderUnrouted]);
    const id = await save(A.dispatcher, route([{ location_id: A.shop1, order_id: A.orderUnrouted }]));
    await asUser(client, A.admin, (q) => q.query("select public.cancel_route($1)", [id]), { commit: true });
    expect(await orderStatus(A.orderUnrouted)).toBe("ready");
    expect((await client.query("select status from public.routes where id = $1", [id])).rows[0].status).toBe("cancelled");
  });
});

describe("GPS uploads", () => {
  const upload = (driver: string, speedsKmh: number[], startMs: number, stepS = 4) =>
    asUser(
      client,
      driver,
      (q) =>
        q.query(
          "insert into public.gps_batches (id, tenant_id, driver_id, recorded_from, recorded_to, point_count, points) values (gen_random_uuid(), $1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), $5, $6)",
          [
            A.tenant, driver, startMs, startMs + (speedsKmh.length - 1) * stepS * 1000, speedsKmh.length,
            JSON.stringify(speedsKmh.map((k, i) => [startMs + i * stepS * 1000, 178.4419 + i * 0.0005, -18.1416, 5, k / 3.6, 90])),
          ],
        ),
      { commit: true },
    );

  it("records a speed event when over the urban limit for 10 seconds or more", async () => {
    const before = await count(client, "select count(*) from public.speed_events where driver_id = $1", [A.driver1]);
    // 48, then 62, 66, 71, 64 over 12 seconds, then back to 45.
    await upload(A.driver1, [48, 62, 66, 71, 64, 45], Date.parse("2026-11-05T01:00:00Z"));
    const events = (await client.query(
      "select duration_s, max_speed_kmh, limit_kmh, zone_name from public.speed_events where driver_id = $1 order by created_at desc, started_at desc limit 1", [A.driver1],
    )).rows;
    expect(await count(client, "select count(*) from public.speed_events where driver_id = $1", [A.driver1])).toBe(before + 1);
    expect(events[0]).toEqual({ duration_s: 16, max_speed_kmh: "71.0", limit_kmh: 50, zone_name: "Town" });
  });

  it("does not record a short burst over the limit", async () => {
    const before = await count(client, "select count(*) from public.speed_events");
    await upload(A.driver1, [48, 60, 62, 45], Date.parse("2026-11-05T02:00:00Z"));
    expect(await count(client, "select count(*) from public.speed_events")).toBe(before);
  });

  it("keeps the latest position per driver for the live map, ignoring older uploads", async () => {
    await upload(A.driver1, [30, 35], Date.parse("2026-11-05T03:00:00Z"));
    await upload(A.driver1, [20], Date.parse("2026-11-05T00:30:00Z"));
    const pos = (await client.query("select recorded_at, speed_kmh from public.driver_positions where driver_id = $1", [A.driver1])).rows[0];
    expect(pos.recorded_at.toISOString()).toBe("2026-11-05T03:00:04.000Z");
    expect(pos.speed_kmh).toBe("35.0");
    const otherTenant = await asUser(client, B.admin, async (q) => count(q, "select count(*) from public.driver_positions where tenant_id = $1", [A.tenant]));
    expect(otherTenant).toBe(0);
  });
});

describe("KaiWorkforce clock-in", () => {
  it("opens and closes a shift for a linked driver, and ignores unknown people", async () => {
    await client.query("update public.tenants set kaiworkforce_enabled = true, kaiworkforce_company_id = 'kw-a' where id = $1", [A.tenant]);
    await client.query("update public.memberships set kaiworkforce_employee_id = 'E-77' where user_id = $1", [A.driver2]);
    const call = (event: string, employee = "E-77", company = "kw-a") =>
      asService(client, async (q) =>
        (await q.query("select public.kaiworkforce_clock($1, $2, $3, 'shift-1', now()) as r", [company, employee, event])).rows[0].r, { commit: true });

    expect(await call("shift.clock_in")).toMatchObject({ result: "opened", driver_id: A.driver2 });
    expect(await call("shift.clock_in")).toMatchObject({ result: "already_open" });
    expect(await call("shift.clock_out")).toMatchObject({ result: "closed" });
    expect(await call("shift.clock_in", "E-00")).toMatchObject({ result: "ignored" });
    expect(await call("shift.clock_in", "E-77", "kw-other")).toMatchObject({ result: "ignored" });
  });

  it("is server only", async () => {
    await expectDenied(asUser(client, A.owner, (q) => q.query("select public.kaiworkforce_clock('kw-a', 'E-77', 'shift.clock_in', 's', now())")));
  });
});

describe("BillZilla", () => {
  const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
    invoice: {
      id, number: `INV-${id}`, status: "confirmed", confirmed_at: "2026-11-05T09:12:00+12:00", currency: "FJD", total: "217.50", cartons: 11,
      customer: { id: "BZ-NEW-1", name: "New Shop", phone: "+679 000 0000", address: "Suva" },
      lines: [{ sku: "RICE-10", description: "Rice 10 kg", quantity: 3, unit: "bag" }],
      ...extra,
    },
  });
  const ingest = (event: string, payload: unknown, org = "bz-a") =>
    asService(client, async (q) => (await q.query("select public.billzilla_ingest($1, $2, $3) as r", [org, event, payload])).rows[0].r, { commit: true });

  beforeAll(async () => {
    await client.query("update public.tenants set billzilla_enabled = true, billzilla_org_id = 'bz-a' where id = $1", [A.tenant]);
  });

  it("stores a confirmed invoice and its customer, and updates it when sent again", async () => {
    await ingest("invoice.confirmed", invoice("bz-900"));
    await ingest("invoice.confirmed", invoice("bz-900", { cartons: 14 }));
    const rows = (await client.query(
      "select o.cartons, o.delivery_status, c.name, c.location_id from public.orders o join public.customers c on c.id = o.customer_id where o.billzilla_invoice_id = 'bz-900'",
    )).rows;
    expect(rows).toEqual([{ cartons: 14, delivery_status: "ready", name: "New Shop", location_id: null }]);
  });

  it("cancelling takes the invoice off routes that have not started", async () => {
    await client.query("update public.customers set location_id = $1 where billzilla_customer_id = 'BZ-NEW-1'", [A.shop2]);
    const order = (await client.query("select id from public.orders where billzilla_invoice_id = 'bz-900'")).rows[0].id;
    const id = await save(A.dispatcher, route([{ location_id: A.shop2, order_id: order }]));
    const r = await ingest("invoice.cancelled", { invoice: { id: "bz-900" } });
    expect(r).toMatchObject({ result: "cancelled", on_route_in_progress: false });
    expect(await count(client, "select count(*) from public.route_stops where route_id = $1", [id])).toBe(0);
    expect(await orderStatus(order)).toBe("cancelled");
  });

  it("refuses an unknown organisation, and people cannot call it", async () => {
    await expect(ingest("invoice.confirmed", invoice("bz-901"), "bz-unknown")).rejects.toThrow(/Unknown BillZilla organisation/);
    await expectDenied(asUser(client, A.admin, (q) => q.query("select public.billzilla_ingest('bz-a', 'invoice.confirmed', '{}')")));
  });
});

describe("nightly trips", () => {
  it("compresses a driver's day into one trip and removes the raw batches", async () => {
    // Two points 1 km apart (about 0.00949 degrees of longitude at this latitude), 60 s apart.
    await client.query(
      `insert into public.gps_batches (id, tenant_id, driver_id, recorded_from, recorded_to, point_count, points) values
        (gen_random_uuid(), $1, $2, '2026-11-03T22:00:00Z', '2026-11-03T22:01:00Z', 3,
         '[[1793743200000, 178.4419, -18.1416, 5, 16.7, 90], [1793743260000, 178.45139, -18.1416, 5, 16.7, 90], [1793743320000, 178.45139, -18.1416, 5, 0, 90]]')`,
      [A.tenant, A.dispatcher],
    );
    const days = await asService(client, async (q) => (await q.query("select * from public.pending_trip_days('2026-11-05') where driver_id = $1", [A.dispatcher])).rows);
    expect(days.map((d) => d.trip_date.toISOString().slice(0, 10))).toEqual(["2026-11-04"]);

    const trip = await asService(client, async (q) =>
      (await q.query("select * from public.finish_trip($1, $2, '2026-11-04', 'archive/a.ndjson.gz')", [A.tenant, A.dispatcher])).rows[0], { commit: true });
    expect(trip.distance_m).toBeGreaterThan(950);
    expect(trip.distance_m).toBeLessThan(1050);
    expect(trip).toMatchObject({ duration_s: 120, moving_s: 60, idle_s: 60, point_count: 3, raw_archive_path: "archive/a.ndjson.gz" });
    expect(Number(trip.max_speed_kmh)).toBeCloseTo(60.1, 0);
    expect(await count(client, "select count(*) from public.gps_batches where driver_id = $1", [A.dispatcher])).toBe(0);
  });

  it("keeps a trip that crosses the 180 degree meridian short", async () => {
    await client.query(
      `insert into public.gps_batches (id, tenant_id, driver_id, recorded_from, recorded_to, point_count, points) values
        (gen_random_uuid(), $1, $2, '2026-11-03T22:00:00Z', '2026-11-03T22:01:00Z', 2,
         '[[1793743200000, 179.999, -16.8, 5, 10, 90], [1793743260000, -179.999, -16.8, 5, 10, 90]]')`,
      [A.tenant, A.owner],
    );
    await asService(client, (q) => q.query("select public.finish_trip($1, $2, '2026-11-04', 'archive/b.ndjson.gz')", [A.tenant, A.owner]), { commit: true });
    const len = (await client.query("select extensions.st_length(geometry) as m, distance_m from public.trips where driver_id = $1", [A.owner])).rows[0];
    expect(len.distance_m).toBeLessThan(300);
    expect(Number(len.m)).toBeLessThan(300);
  });

  it("merges segment speeds as a weighted average", async () => {
    await asService(client, (q) => q.query("select public.add_segment_speeds($1, $2)", [A.tenant, JSON.stringify([
      { osm_way_id: 1000, forward: true, weekday: 1, hour: 8, samples: 20, mean_speed_kmh: 42.5 },
    ])]), { commit: true });
    const row = (await client.query("select sample_count, mean_speed_kmh from public.segment_speeds where tenant_id = $1 and osm_way_id = 1000", [A.tenant])).rows[0];
    expect(row).toEqual({ sample_count: 40, mean_speed_kmh: "37.5" });
  });
});
