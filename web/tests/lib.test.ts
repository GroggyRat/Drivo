import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "@/lib/csv";
import { formatDate, formatDistance, formatDuration, formatTime, todayIn } from "@/lib/format";
import { estimateFuel, fuelFormula } from "@/lib/fuel";
import { boundsOf, haversine } from "@/lib/geo";
import { linkSecret, sign, signedHeaders, verify } from "@/lib/hmac";
import { contactAddress, contactPhone, decryptTokens, encryptTokens, jwtClaim, mapInvoice, validXeroSignature, xeroDate, type XeroInvoice } from "@/lib/integrations/xero-core";
import { createHmac } from "node:crypto";
import { signInEmail } from "@/lib/email-core";
import { estimateKmh, type SpeedSample } from "@/app/driver/navigation";
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

describe("estimateKmh", () => {
  // About 111 m per 0.001 degree of latitude.
  const at = (lat: number, t: number, accuracy = 8) => ({ position: [178.45, lat] as [number, number], at: t, accuracy });

  it("uses the phone's own speed when it gives one", () => {
    const recent: SpeedSample[] = [];
    expect(estimateKmh(recent, at(-18.1, 0), 13.9)).toBeCloseTo(50, 0);
  });

  it("works out speed from distance over time when the phone gives none", () => {
    const recent: SpeedSample[] = [];
    expect(estimateKmh(recent, at(-18.1, 0), null)).toBeNull();
    estimateKmh(recent, at(-18.0993, 2500), null);
    // 0.0014 degrees (about 156 m) in 10 s is about 56 km/h.
    expect(estimateKmh(recent, at(-18.0986, 10_000), null)).toBeGreaterThan(50);
    expect(estimateKmh(recent, at(-18.0986, 10_000), null)).toBeLessThan(62);
  });

  it("treats GPS jitter as standing still and skips rough fixes", () => {
    const recent: SpeedSample[] = [];
    estimateKmh(recent, at(-18.1, 0), null);
    expect(estimateKmh(recent, at(-18.10003, 5000), null)).toBe(0);
    expect(estimateKmh(recent, at(-18.09, 6000, 120), null)).toBeNull();
  });
});

describe("Xero", () => {
  const invoice: XeroInvoice = {
    InvoiceID: "inv-1", InvoiceNumber: "INV-0042", Type: "ACCREC", Status: "AUTHORISED", DateString: "2026-11-13T00:00:00", CurrencyCode: "FJD", Total: 184.5,
    Contact: { ContactID: "c-1", Name: "Samabula Mini Mart" },
    LineItems: [{ Description: "Rice 10 kg", Quantity: 6, ItemCode: "RICE-10" }, { Description: "Oil 4 L", Quantity: 2.5 }, { Description: "", Quantity: 0 }],
  };
  const contact = {
    ContactID: "c-1", Name: "Samabula Mini Mart Ltd",
    Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "3310000", PhoneAreaCode: "", PhoneCountryCode: "679" }, { PhoneType: "MOBILE", PhoneNumber: "9990142", PhoneCountryCode: "+679" }, { PhoneType: "FAX", PhoneNumber: "" }],
    Addresses: [{ AddressType: "POBOX", AddressLine1: "PO Box 12", City: "Suva" }, { AddressType: "STREET", AddressLine1: "14 Ratu Mara Road", City: "Samabula", Region: "Suva" }],
  };

  it("turns an approved sales invoice into a delivery, with cartons from the quantities", () => {
    expect(mapInvoice(invoice, "2026-11-10", new Map([["c-1", contact]]))).toEqual({
      id: "inv-1", number: "INV-0042", status: "AUTHORISED", date: "2026-11-13T00:00:00Z", currency: "FJD", total: "184.50", cartons: 9,
      lines: [{ sku: "RICE-10", description: "Rice 10 kg", quantity: 6, unit: null }, { sku: null, description: "Oil 4 L", quantity: 2.5, unit: null }],
      customer: { id: "c-1", name: "Samabula Mini Mart Ltd", phone: "+679 9990142", address: "14 Ratu Mara Road, Samabula, Suva" },
    });
  });

  it("uses the invoice's own customer name when the contact was not fetched", () => {
    expect(mapInvoice(invoice, "2026-11-10")).toMatchObject({ customer: { id: "c-1", name: "Samabula Mini Mart", phone: null, address: null } });
  });

  it("leaves out bills, drafts, invoices from before connecting and invoices with no customer", () => {
    expect(mapInvoice({ ...invoice, Type: "ACCPAY" }, "2026-11-10")).toBeNull();
    expect(mapInvoice({ ...invoice, Status: "DRAFT" }, "2026-11-10")).toBeNull();
    expect(mapInvoice({ ...invoice, Status: "SUBMITTED" }, "2026-11-10")).toBeNull();
    expect(mapInvoice(invoice, "2026-11-14")).toBeNull();
    expect(mapInvoice({ ...invoice, Contact: null }, "2026-11-10")).toBeNull();
    expect(mapInvoice({ ...invoice, Status: "PAID" }, "2026-11-13")).toMatchObject({ status: "PAID" });
  });

  it("passes voided and deleted invoices on as cancellations, whatever their date", () => {
    expect(mapInvoice({ ...invoice, Status: "VOIDED", DateString: "2020-01-01T00:00:00" }, "2026-11-10")).toEqual({ id: "inv-1", status: "VOIDED" });
    expect(mapInvoice({ ...invoice, Status: "DELETED" }, "2026-11-10")).toEqual({ id: "inv-1", status: "DELETED" });
  });

  it("picks the mobile then the main phone, and the street address", () => {
    expect(contactPhone({ ContactID: "x", Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "3310000", PhoneAreaCode: "3", PhoneCountryCode: "679" }] })).toBe("+679 3 3310000");
    expect(contactPhone({ ContactID: "x", Phones: [{ PhoneType: "DEFAULT", PhoneNumber: " " }] })).toBeNull();
    expect(contactAddress({ ContactID: "x", Addresses: [{ AddressType: "POBOX", AddressLine1: "PO Box 12", City: "Suva" }] })).toBe("PO Box 12, Suva");
    expect(contactAddress(undefined)).toBeNull();
  });

  it("accepts only webhooks signed with the app's key", () => {
    const body = JSON.stringify({ events: [], firstEventSequence: 0, lastEventSequence: 0, entropy: "ABC" });
    const good = createHmac("sha256", "webhook-key").update(body).digest("base64");
    expect(validXeroSignature("webhook-key", body, good)).toBe(true);
    expect(validXeroSignature("webhook-key", body + " ", good)).toBe(false);
    expect(validXeroSignature("other-key", body, good)).toBe(false);
    expect(validXeroSignature("webhook-key", body, null)).toBe(false);
    expect(validXeroSignature("", body, createHmac("sha256", "").update(body).digest("base64"))).toBe(false);
  });

  it("encrypts tokens so they only open with the same secret and have not been changed", () => {
    const tokens = { access_token: "a.b.c", refresh_token: "refresh-123", expires_at: 1_800_000_000_000 };
    const stored = encryptTokens("client-secret", tokens);
    expect(stored).not.toContain("refresh-123");
    expect(encryptTokens("client-secret", tokens)).not.toBe(stored);
    expect(decryptTokens("client-secret", stored)).toEqual(tokens);
    expect(() => decryptTokens("another-secret", stored)).toThrow();
    const parts = stored.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptTokens("client-secret", parts.join("."))).toThrow();
  });

  it("reads the auth event from a token and writes Xero's date form", () => {
    const token = `x.${Buffer.from(JSON.stringify({ authentication_event_id: "evt-9" })).toString("base64url")}.y`;
    expect(jwtClaim(token, "authentication_event_id")).toBe("evt-9");
    expect(jwtClaim("not-a-token", "authentication_event_id")).toBeNull();
    expect(xeroDate("2026-11-05")).toBe("DateTime(2026,11,5)");
  });
});

describe("the sign-in email", () => {
  const base = { name: "Salote Naivalu", companyName: "Nadera Distributors", email: "salote@nadera.test", password: "aB3-xY_9kLmn", signInUrl: "https://drivo.example/sign-in" };

  it("tells a new person where to sign in, with their email and temporary password", () => {
    const m = signInEmail({ kind: "created", ...base });
    expect(m.subject).toBe("Your Drivo sign-in for Nadera Distributors");
    expect(m.text).toContain("Hello Salote Naivalu,");
    expect(m.text).toContain("An account has been made for you on Drivo for Nadera Distributors.");
    expect(m.text).toContain("Sign in at: https://drivo.example/sign-in");
    expect(m.text).toContain("Temporary password: aB3-xY_9kLmn");
    expect(m.html).toContain("aB3-xY_9kLmn");
  });

  it("says the old password no longer works after a reset, and escapes names in the HTML", () => {
    const m = signInEmail({ kind: "reset", ...base, name: "<b>Jo</b>", companyName: "R&D \"Ltd\"" });
    expect(m.subject).toBe('Your Drivo password was reset for R&D "Ltd"');
    expect(m.text).toContain("Your old password no longer works.");
    expect(m.html).toContain("&lt;b&gt;Jo&lt;/b&gt;");
    expect(m.html).toContain("R&amp;D &quot;Ltd&quot;");
    expect(m.html).not.toContain("<b>Jo</b>");
  });

  it("works without a name or a company, and has no em dashes or exclamation marks", () => {
    const m = signInEmail({ kind: "created", ...base, name: null, companyName: null });
    expect(m.subject).toBe("Your Drivo sign-in");
    expect(m.text.startsWith("Hello,")).toBe(true);
    expect(m.text + m.html).not.toMatch(/[\u2014!]/);
  });
});
