import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

// The parts of the Xero link that touch no network or database: reading
// Xero's invoices into Drivo's shape, checking webhook signatures and
// encrypting the tokens. Kept apart so they can be tested on their own.

/** What Drivo asks Xero for: read invoices and contacts, and stay connected. */
export const XERO_SCOPES = "offline_access accounting.invoices.read accounting.contacts.read";

export type XeroTokens = { access_token: string; refresh_token: string; expires_at: number };

export type XeroInvoice = {
  InvoiceID: string;
  InvoiceNumber?: string | null;
  Type?: string;
  Status?: string;
  DateString?: string | null;
  CurrencyCode?: string | null;
  Total?: number | null;
  Contact?: { ContactID?: string; Name?: string | null } | null;
  LineItems?: { Description?: string | null; Quantity?: number | null; ItemCode?: string | null }[] | null;
};

export type XeroContact = {
  ContactID: string;
  Name?: string | null;
  Phones?: { PhoneType?: string; PhoneCountryCode?: string | null; PhoneAreaCode?: string | null; PhoneNumber?: string | null }[] | null;
  Addresses?: { AddressType?: string; AddressLine1?: string | null; AddressLine2?: string | null; City?: string | null; Region?: string | null }[] | null;
};

/** The shape xero_ingest stores. */
export type IngestInvoice =
  | { id: string; status: "VOIDED" | "DELETED" }
  | {
      id: string; number: string; status: string; date: string | null; currency: string; total: string | null; cartons: number;
      lines: { sku: string | null; description: string; quantity: number; unit: null }[];
      customer: { id: string; name: string; phone: string | null; address: string | null };
    };

const text = (v: string | null | undefined, max: number) => (v ?? "").trim().slice(0, max);

export function contactPhone(c: XeroContact | undefined): string | null {
  const phones = (c?.Phones ?? []).filter((p) => text(p.PhoneNumber, 50));
  const best = phones.find((p) => p.PhoneType === "MOBILE") ?? phones.find((p) => p.PhoneType === "DEFAULT") ?? phones[0];
  if (!best) return null;
  const country = text(best.PhoneCountryCode, 6).replace(/^\+?/, "");
  return [country ? `+${country}` : "", text(best.PhoneAreaCode, 10), text(best.PhoneNumber, 50)].filter(Boolean).join(" ").slice(0, 50) || null;
}

export function contactAddress(c: XeroContact | undefined): string | null {
  const addresses = (c?.Addresses ?? []).filter((a) => text(a.AddressLine1, 200) || text(a.City, 100));
  const best = addresses.find((a) => a.AddressType === "STREET") ?? addresses[0];
  if (!best) return null;
  return [best.AddressLine1, best.AddressLine2, best.City, best.Region].map((p) => text(p, 200)).filter(Boolean).join(", ").slice(0, 500) || null;
}

/**
 * One Xero invoice as Drivo stores it, or null when it is not for delivery:
 * not a sales invoice, still a draft, no customer, or dated before the
 * company connected. Xero has no cartons, so cartons is the sum of the line
 * quantities, rounded up.
 */
export function mapInvoice(inv: XeroInvoice, importFrom: string, contacts: Map<string, XeroContact> = new Map()): IngestInvoice | null {
  if (!inv.InvoiceID || (inv.Type && inv.Type !== "ACCREC")) return null;
  const status = (inv.Status ?? "").toUpperCase();
  if (status === "VOIDED" || status === "DELETED") return { id: inv.InvoiceID, status };
  if (status !== "AUTHORISED" && status !== "PAID") return null;
  const date = inv.DateString ? inv.DateString.slice(0, 10) : null;
  if (!date || date < importFrom) return null;
  const contactId = inv.Contact?.ContactID;
  if (!contactId) return null;
  const contact = contacts.get(contactId);
  const lines = (inv.LineItems ?? [])
    .filter((l) => text(l.Description, 500) || l.Quantity)
    .map((l) => ({ sku: text(l.ItemCode, 100) || null, description: text(l.Description, 500) || text(l.ItemCode, 100) || "Item", quantity: Number(l.Quantity ?? 0), unit: null }));
  return {
    id: inv.InvoiceID,
    number: text(inv.InvoiceNumber, 90) || inv.InvoiceID,
    status,
    date: `${date}T00:00:00Z`,
    currency: /^[A-Z]{3}$/.test(inv.CurrencyCode ?? "") ? inv.CurrencyCode! : "FJD",
    total: inv.Total == null ? null : Number(inv.Total).toFixed(2),
    cartons: Math.min(100000, Math.ceil(lines.reduce((sum, l) => sum + Math.max(0, l.quantity), 0))),
    lines,
    customer: {
      id: contactId,
      name: text(contact?.Name ?? inv.Contact?.Name, 200) || "Xero customer",
      phone: contactPhone(contact),
      address: contactAddress(contact),
    },
  };
}

/** Xero signs each webhook: base64 HMAC-SHA256 of the raw body with the app's webhook key. */
export function validXeroSignature(webhookKey: string, rawBody: string, signature: string | null): boolean {
  if (!webhookKey || !signature) return false;
  const expected = Buffer.from(createHmac("sha256", webhookKey).update(rawBody).digest("base64"));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const tokenKey = (clientSecret: string) => Buffer.from(hkdfSync("sha256", clientSecret, "drivo-xero", "tokens", 32));

/** Tokens are encrypted before they reach the database (AES-256-GCM, key derived from the app's client secret). */
export function encryptTokens(clientSecret: string, tokens: XeroTokens): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(clientSecret), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptTokens(clientSecret: string, stored: string): XeroTokens {
  const [version, iv, tag, data] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Stored Xero tokens are not readable");
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(clientSecret), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")) as XeroTokens;
}

/** A claim from a JWT's payload, without checking the signature (the token came straight from Xero over TLS). */
export function jwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload[claim] === "string" ? (payload[claim] as string) : null;
  } catch {
    return null;
  }
}

/** Xero's where-clause date: DateTime(2026,11,10). */
export const xeroDate = (isoDate: string) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `DateTime(${y},${m},${d})`;
};
