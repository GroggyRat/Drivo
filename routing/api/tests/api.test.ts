import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandler } from "../src/app.js";
import { RoutingEngine } from "../src/engine.js";
import { decodePolyline6, encodePolyline6 } from "../src/polyline.js";

const KEY = "test-key-that-is-long-enough-123";
const DEPOT: [number, number] = [178.4335, -18.1262];
const STOPS = [
  { id: "far", position: [178.533, -18.031] as [number, number], serviceS: 300, cartons: 10 },
  { id: "near", position: [178.4258, -18.1398] as [number, number], serviceS: 300, cartons: 5 },
];

// Fake Valhalla and VROOM: a matrix where "near" is close and "far" is far,
// and VROOM that visits jobs in the order of the cost row from the depot.
const calls: { url: string; body: any }[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, body });
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.endsWith("/status")) return json({ version: "3.5.1" });
  if (url.endsWith("/sources_to_targets")) {
    const t = [[0, 900, 120], [900, 0, 950], [120, 950, 0]];
    const d = [[0, 15, 1.5], [15, 0, 16], [1.5, 16, 0]];
    return json({ sources_to_targets: t.map((row, i) => row.map((time, j) => ({ time, distance: d[i][j] }))) });
  }
  if (url.startsWith("http://vroom")) {
    if (body.vehicles[0].capacity && body.vehicles[0].capacity[0] < 15) return json({ code: 0, unassigned: [{ id: 1 }], routes: [] });
    const costs: number[] = body.matrices.car.costs[0];
    const jobs = [...body.jobs].sort((a: any, b: any) => costs[a.location_index] - costs[b.location_index]);
    return json({ code: 0, unassigned: [], routes: [{ steps: [{ type: "start" }, ...jobs.map((j: any) => ({ type: "job", job: j.id })), { type: "end" }] }] });
  }
  if (url.endsWith("/route")) {
    if (body.format === "osrm") return json({ code: "Ok", routes: [{ legs: [] }], echo: { costing: body.costing } });
    const legs = body.locations.slice(1).map((l: any, i: number) => ({
      shape: encodePolyline6([[body.locations[i].lon, body.locations[i].lat], [l.lon, l.lat]]),
      summary: { time: 600, length: 5 },
    }));
    return json({ trip: { legs } });
  }
  if (url.endsWith("/trace_attributes")) {
    return json({ shape: encodePolyline6([[178.44, -18.14], [178.45, -18.14]]), edges: [{ way_id: 42, length: 1.05, speed: 37, begin_shape_index: 0, end_shape_index: 1, forward: true }] });
  }
  return json({ error: "unexpected" }, 500);
};

let server: Server;
let base: string;
beforeAll(async () => {
  const engine = new RoutingEngine({ valhallaUrl: "http://valhalla", vroomUrl: "http://vroom", costing: "truck", fetch: fakeFetch });
  server = createServer(createHandler({ apiKey: KEY, engine, valhallaUrl: "http://valhalla", costing: "truck", fetchImpl: fakeFetch }));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const post = (path: string, body: unknown, key = KEY) =>
  fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("polyline6", () => {
  it("round-trips coordinates, including east of the 180 degree meridian", () => {
    const line: [number, number][] = [[179.98, -16.79], [-179.88, -16.69], [-178.804, -18.233]];
    expect(decodePolyline6(encodePolyline6(line))).toEqual(line);
  });
});

describe("routing API", () => {
  it("refuses requests without the key, and health needs none", async () => {
    expect((await post("/v1/plan", {}, "wrong")).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("validates the request", async () => {
    const res = await post("/v1/plan", { depot: DEPOT, stops: [], departureAt: "2026-11-06T20:00:00Z" });
    expect(res.status).toBe(400);
  });

  it("plans three options with road lines, legs and arrival times", async () => {
    const res = await post("/v1/plan", { depot: DEPOT, stops: STOPS, departureAt: "2026-11-06T20:00:00Z", litresPer100Km: 14.5 });
    expect(res.status).toBe(200);
    const { options } = await res.json();
    expect(options.map((o: any) => o.objective)).toEqual(["lowest_fuel", "fastest", "shortest"]);
    for (const o of options) {
      expect(o.order).toEqual(["near", "far"]);
      expect(o.legs).toHaveLength(3);
      expect(o.distanceM).toBe(15000);
      expect(o.etas).toEqual(["2026-11-06T20:10:00.000Z", "2026-11-06T20:25:00.000Z"]);
      expect(o.durationS).toBe(3 * 600 + 2 * 300);
      expect(o.geometry[0]).toEqual(DEPOT);
    }
    const vroomBodies = calls.filter((c) => c.url.startsWith("http://vroom")).map((c) => c.body);
    // Shortest uses distances, fastest uses times, lowest fuel uses millilitres.
    expect(vroomBodies[1].matrices.car.costs[0][1]).toBe(900);
    expect(vroomBodies[2].matrices.car.costs[0][1]).toBe(15000);
    expect(vroomBodies[0].matrices.car.costs[0][1]).toBe(Math.round((15000 * 14.5) / 100 + (900 * 1000) / 3600));
  });

  it("explains when the stops do not fit the vehicle", async () => {
    const res = await post("/v1/plan", { depot: DEPOT, stops: STOPS, departureAt: "2026-11-06T20:00:00Z", capacityCartons: 10 });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/do not fit/);
  });

  it("keeps a fixed order for /v1/sequence", async () => {
    const res = await post("/v1/sequence", { depot: DEPOT, stops: STOPS, departureAt: "2026-11-06T20:00:00Z", objective: "fastest" });
    expect((await res.json()).option.order).toEqual(["far", "near"]);
  });

  it("passes navigation requests to Valhalla in OSRM format with server costing", async () => {
    const res = await post("/v1/navigation/route", { locations: [{ lat: -18.1, lon: 178.4 }, { lat: -18.0, lon: 178.5 }], costing: "pedestrian" });
    expect((await res.json()).echo.costing).toBe("truck");
  });

  it("map-matches a trace into a line and per-way speeds", async () => {
    const res = await post("/v1/map-match", { points: [{ lon: 178.44, lat: -18.14, time: 0 }, { lon: 178.45, lat: -18.14, time: 100 }] });
    expect(await res.json()).toEqual({ geometry: [[178.44, -18.14], [178.45, -18.14]], edges: [{ wayId: 42, lengthM: 1050, speedKmh: 37, forward: true }] });
  });
});
