import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, createTestDatabase, expectDenied } from "./helpers";
import { A, B, PLATFORM_ADMIN, STRANGER, loadFixture } from "./fixtures";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.Client;

// Tenant A is in Suva, tenant B in Lautoka. Each fixture has one open police
// report by its first driver, 200 m east of its centre.
const SUVA = [178.4419, -18.1416] as const;

const enable = (tenant: string, on = true) =>
  asUser(client, PLATFORM_ADMIN, (q) => q.query("select public.platform_set_road_alerts($1, $2)", [tenant, on]), { commit: true });
const near = (user: string, lon: number, lat: number, radius = 5000) =>
  asUser(client, user, async (q) => (await q.query("select * from public.road_alerts_near($1, $2, $3)", [lon, lat, radius])).rows);
const report = (user: string, kind: string, lon: number, lat: number) =>
  asUser(client, user, async (q) => (await q.query("select public.report_road_alert($1, $2, $3) as a", [kind, lon, lat])).rows[0].a, { commit: true });
const vote = (user: string, id: string, still: boolean) =>
  asUser(client, user, async (q) => (await q.query("select public.vote_road_alert($1, $2) as a", [id, still])).rows[0].a, { commit: true });

beforeAll(async () => {
  db = await createTestDatabase();
  client = db.client;
  await loadFixture(client);
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe("the road alerts add-on", () => {
  it("is off for a new company, and only the platform can turn it on", async () => {
    await expectDenied(near(A.driver1, ...SUVA));
    await expectDenied(report(A.driver1, "hazard", ...SUVA));
    await expectDenied(asUser(client, A.owner, (q) => q.query("select public.platform_set_road_alerts($1, true)", [A.tenant])));
    await expectDenied(asUser(client, A.admin, (q) => q.query("update public.tenants set road_alerts_enabled = true where id = $1", [A.tenant])));
    await enable(A.tenant);
    const rows = await asUser(client, PLATFORM_ADMIN, async (q) => (await q.query("select slug, road_alerts_enabled from public.platform_list_tenants()")).rows);
    expect(rows).toEqual([{ slug: "tenant-a", road_alerts_enabled: true }, { slug: "tenant-b", road_alerts_enabled: false }]);
  });

  it("shows open alerts near a point without the reporter or the company", async () => {
    const rows = await near(A.driver2, ...SUVA);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["confirmations", "id", "kind", "lat", "lon", "mine", "reported_at", "voted"]);
    expect(rows[0]).toMatchObject({ id: A.roadAlert, kind: "police", mine: false, voted: false, confirmations: 0 });
    expect((await near(A.driver1, ...SUVA))[0].mine).toBe(true);
    // Lautoka is about 100 km away.
    expect(await near(A.driver2, ...SUVA, 300_000)).toHaveLength(2);
  });

  it("is shared between companies that have it, and closed to those that do not", async () => {
    await expectDenied(near(B.driver1, ...SUVA));
    await expectDenied(vote(B.driver1, A.roadAlert, false));
    await expectDenied(near(STRANGER, ...SUVA));
    await enable(B.tenant);
    expect((await near(B.driver1, ...SUVA)).map((r) => r.id)).toEqual([A.roadAlert]);
    // Through the table, B still sees none of A's rows and A's driver sees none at all.
    const table = (user: string) => asUser(client, user, async (q) => (await q.query("select id from public.road_alerts")).rows.map((r) => r.id));
    expect(await table(B.admin)).toEqual([B.roadAlert]);
    expect(await table(A.driver1)).toEqual([]);
    await expectDenied(asUser(client, A.admin, (q) => q.query("select confirmed_by from public.road_alerts")));
    await expectDenied(asUser(client, A.admin, (q) => q.query("delete from public.road_alerts where id = $1", [A.roadAlert])));
  });

  it("a second report of the same thing nearby confirms the first", async () => {
    const again = await report(B.driver1, "police", SUVA[0] + 0.0025, SUVA[1]);
    expect(again).toMatchObject({ id: A.roadAlert, confirmations: 1, mine: false, voted: true });
    const other = await report(B.driver1, "hazard", SUVA[0] + 0.0025, SUVA[1]);
    expect(other.id).not.toBe(A.roadAlert);
    expect(other).toMatchObject({ kind: "hazard", mine: true, active: true });
    // The reporter takes the hazard back.
    expect(await vote(B.driver1, other.id, false)).toMatchObject({ active: false });
    expect((await near(A.driver2, ...SUVA)).map((r) => r.id)).toEqual([A.roadAlert]);
  });

  it("clears once more drivers say it is gone than say it is still there", async () => {
    // One confirmation so far (B's driver). One "Not there" is not enough.
    expect(await vote(A.driver2, A.roadAlert, false)).toMatchObject({ active: true });
    expect(await vote(B.driver2, A.roadAlert, false)).toMatchObject({ active: false });
    expect(await near(A.driver2, ...SUVA)).toEqual([]);
    expect(await vote(A.driver2, A.roadAlert, true)).toEqual({ id: A.roadAlert, active: false });
  });

  it("keeps working across the 180 degree meridian", async () => {
    const taveuni = await report(A.driver1, "speed_camera", -179.97, -16.85);
    const rows = await near(A.driver2, 179.99, -16.85, 10_000);
    expect(rows.map((r) => r.id)).toEqual([taveuni.id]);
  });

  it("limits how many reports one person can make in an hour", async () => {
    for (let i = 0; i < 11; i++) await report(A.driver2, "hazard", 178.0 + i * 0.01, -17.9);
    await report(A.driver2, "hazard", 178.3, -17.9);
    await expect(report(A.driver2, "hazard", 178.4, -17.9)).rejects.toThrow(/Too many reports/);
  });

  it("stops for a suspended company and when the add-on is turned off", async () => {
    await enable(B.tenant, false);
    await expectDenied(near(B.driver1, ...SUVA));
    await asUser(client, PLATFORM_ADMIN, (q) => q.query("select public.platform_set_tenant_status($1, 'suspended')", [A.tenant]), { commit: true });
    await expectDenied(near(A.driver1, ...SUVA));
    await expectDenied(report(A.driver1, "hazard", ...SUVA));
  });
});
