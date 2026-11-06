import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "@/lib/csv";
import { formatDate, formatDistance, formatDuration, formatTime, todayIn } from "@/lib/format";
import { estimateFuel, fuelFormula } from "@/lib/fuel";
import { boundsOf, haversine } from "@/lib/geo";
import { linkSecret, sign, signedHeaders, verify } from "@/lib/hmac";
import { buildOption, EstimateRoutingProvider, orderStops } from "@/lib/routing/estimate";

describe("webhook signatures", () => {
  const secret = linkSecret("master", "bz-demo-nadera");
  const body = JSON.stringify({ event: "invoice.confirmed" });

  it("accepts a fresh, correct signature", () => {
    const h = signedHeaders(secret, "invoice.confirmed", body, "d1", 1_000_000);
    expect(verify(secret, { timestamp: h["X-KaiTech-Timestamp"], signature: h["X-KaiTech-Signature"] }, body, 1_000_010)).toEqual({ ok: true });
  });

  it("refuses a changed body, a stale request, another link's secret and missing headers", () => {
    const ts = "1000000";
    const sig = sign(secret, ts, body);
    expect(verify(secret, { timestamp: ts, signature: sig }, body + " ", 1_000_000)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(secret, { timestamp: ts, signature: sig }, body, 1_000_000 + 301)).toEqual({ ok: false, reason: "stale" });
    expect(verify(linkSecret("master", "other-org"), { timestamp: ts, signature: sig }, body, 1_000_000)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(secret, { timestamp: null, signature: sig }, body)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("fuel estimate", () => {
  it("is distance x L/100 km / 100 plus idle per stop, with cost", () => {
    const r = estimateFuel({ distanceM: 40_000, litresPer100Km: 14.5, stops: 8, idleLitresPerStop: 0.1, pricePerLitre: 2.95 });
    expect(r).toEqual({ km: 40, driving: 5.8, idle: 0.8, litres: 6.6, cost: 19.47 });
    expect(fuelFormula({ distanceM: 40_000, litresPer100Km: 14.5, stops: 8, idleLitresPerStop: 0.1 })).toBe(
      "40 km x 14.5 L/100 km / 100 = 5.8 L, plus 8 stops x 0.1 L idle = 0.8 L",
    );
  });
});

describe("geography across the 180 degree meridian", () => {
  it("measures Taveuni across the line as about 15 km", () => {
    const d = haversine([179.98, -16.79], [-179.88, -16.69]);
    expect(d).toBeGreaterThan(14_000);
    expect(d).toBeLessThan(20_000);
  });

  it("fits Suva and Lakeba in one small box, not around the world", () => {
    const b = boundsOf([[178.44, -18.14], [-178.8, -18.23]])!;
    expect(b[1][0] - b[0][0]).toBeLessThan(4);
  });
});

describe("estimate routing", () => {
  const depot: [number, number] = [178.4335, -18.1262];
  const stops = [
    { id: "nausori", position: [178.533, -18.031] as [number, number], serviceS: 360 },
    { id: "suva", position: [178.4258, -18.1398] as [number, number], serviceS: 360 },
    { id: "nabua", position: [178.459, -18.118] as [number, number], serviceS: 360 },
    { id: "nakasi", position: [178.516, -18.056] as [number, number], serviceS: 360 },
  ];

  it("orders stops sensibly from the depot", () => {
    const order = orderStops([depot, ...stops.map((s) => s.position)]).map((i) => stops[i - 1].id);
    // Either direction around the loop is fine; Nakasi must sit next to Nausori.
    const i = order.indexOf("nakasi");
    expect(Math.abs(i - order.indexOf("nausori"))).toBe(1);
  });

  it("gives times that add up and three labelled options", async () => {
    const options = await new EstimateRoutingProvider().plan({ depot, stops, departureAt: "2026-11-06T20:00:00Z" });
    expect(options.map((o) => o.objective)).toEqual(["lowest_fuel", "fastest", "shortest"]);
    const o = options[0];
    expect(o.source).toBe("estimate");
    expect(o.etas).toHaveLength(4);
    expect(new Date(o.returnAt).getTime() - new Date("2026-11-06T20:00:00Z").getTime()).toBe(o.durationS * 1000);
    expect(o.legs.reduce((s, l) => s + l.distanceM, 0)).toBe(o.distanceM);
  });

  it("keeps a fixed order when asked", () => {
    const o = buildOption({ depot, stops, departureAt: "2026-11-06T20:00:00Z" }, ["suva", "nabua", "nakasi", "nausori"], "fastest");
    expect(o.order).toEqual(["suva", "nabua", "nakasi", "nausori"]);
  });
});

describe("CSV", () => {
  it("reads quoted fields and headers with spaces", () => {
    expect(parseCsv('Name,Type,Lat\n"Shop, Suva",shop,-18.1\n')).toEqual([{ name: "Shop, Suva", type: "shop", lat: "-18.1" }]);
  });

  it("writes CSV that spreadsheets cannot run as formulas", () => {
    expect(toCsv(["a", "b"], [["=SUM(1)", 'He said "hi"']])).toBe('a,b\r\n\'=SUM(1),"He said ""hi"""\r\n');
  });
});

describe("formatting", () => {
  it("shows dates as DD/MM/YYYY and times in Fiji time", () => {
    expect(formatDate("2026-11-05T20:30:00Z", "Pacific/Fiji")).toBe("06/11/2026");
    expect(formatTime("2026-11-05T20:30:00Z", "Pacific/Fiji")).toBe("08:30");
    expect(formatDate("2026-11-06")).toBe("06/11/2026");
    expect(todayIn("Pacific/Fiji")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("formats distance and duration in plain units", () => {
    expect(formatDistance(850)).toBe("850 m");
    expect(formatDistance(12_340)).toBe("12 km");
    expect(formatDuration(5400)).toBe("1 h 30 min");
  });
});
