import { describe, expect, it } from "vitest";
import type { LngLat } from "@/lib/geo";
import { loadRoadGraph } from "@/lib/routing/graph";
import { bestOrder, RoadGraphRoutingProvider, RoadUnreachableError } from "@/lib/routing/roadGraph";
import type { PlanRequest } from "@/lib/routing/types";

// Runs against the real Fiji road graph (web/data/fiji-roads.bin).
const graph = loadRoadGraph()!;
const provider = new RoadGraphRoutingProvider(graph);

const WALU_BAY: LngLat = [178.4335, -18.1262];
const NAUSORI: LngLat = [178.5603, -18.0313];

const request = (depot: LngLat, stops: LngLat[]): PlanRequest => ({
  depot,
  stops: stops.map((position, i) => ({ id: `s${i + 1}`, position, serviceS: 600 })),
  departureAt: "2026-11-07T08:00:00+12:00",
  litresPer100Km: 14.5,
});

describe("Fiji road graph", () => {
  it("loads", () => {
    expect(graph.nodeCount).toBeGreaterThan(10_000);
    expect(graph.edgeCount).toBeGreaterThan(10_000);
  });

  it("snaps a shop to the nearest road", () => {
    const s = graph.snap(WALU_BAY)!;
    expect(s.offRoadM).toBeLessThan(300);
  });

  it("drives Walu Bay to Nausori by road, about 19 km like Valhalla", async () => {
    const option = await provider.sequence(request(WALU_BAY, [NAUSORI]), "fastest");
    const out = option.legs[0];
    expect(out.distanceM).toBeGreaterThan(16_000);
    expect(out.distanceM).toBeLessThan(23_000);
    expect(out.durationS).toBeGreaterThan(15 * 60);
    expect(out.durationS).toBeLessThan(40 * 60);
    expect(option.geometry.length).toBeGreaterThan(20);
  });

  it("plans three options for several Suva stops, each with a road line and arrival times", async () => {
    const stops: LngLat[] = [[178.4419, -18.1416], [178.4651, -18.1180], [178.4562, -18.0923], [178.4846, -18.0716]];
    const options = await provider.plan(request(WALU_BAY, stops));
    expect(options.map((o) => o.objective)).toEqual(["lowest_fuel", "fastest", "shortest"]);
    for (const o of options) {
      expect([...o.order].sort()).toEqual(["s1", "s2", "s3", "s4"]);
      expect(o.legs).toHaveLength(5);
      expect(o.etas).toHaveLength(4);
      expect(o.source).toBe("road_graph");
    }
    const shortest = options.find((o) => o.objective === "shortest")!;
    const fastest = options.find((o) => o.objective === "fastest")!;
    expect(shortest.distanceM).toBeLessThanOrEqual(fastest.distanceM + 1);
  });

  it("routes across the 180 degree meridian on Taveuni", async () => {
    const waiyevo: LngLat = [179.9775, -16.7892];
    const matei: LngLat = [-179.8800, -16.6880];
    const option = await provider.sequence(request(waiyevo, [matei]), "fastest");
    expect(option.legs[0].distanceM).toBeGreaterThan(15_000);
    expect(option.legs[0].distanceM).toBeLessThan(40_000);
    for (const [lon] of option.geometry) expect(Math.abs(lon)).toBeLessThanOrEqual(180);
  });

  it("explains when there is no road between islands", async () => {
    const lakeba: LngLat = [-178.8020, -18.1980];
    await expect(provider.plan(request(WALU_BAY, [lakeba]))).rejects.toBeInstanceOf(RoadUnreachableError);
  });
});

describe("stop order", () => {
  it("finds the round trip on an asymmetric matrix", () => {
    // Depot 0; going 1 -> 2 -> 3 is cheap, the reverse is expensive.
    const c = [
      [0, 1, 5, 9],
      [9, 0, 1, 5],
      [9, 9, 0, 1],
      [1, 9, 9, 0],
    ];
    expect(bestOrder(c)).toEqual([1, 2, 3]);
  });
});
