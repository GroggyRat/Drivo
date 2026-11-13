import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  XERO_SCOPES, decryptTokens, encryptTokens, jwtClaim, mapInvoice, xeroDate,
  type IngestInvoice, type XeroContact, type XeroInvoice, type XeroTokens,
} from "./xero-core";

// XeroClient: how Drivo talks to Xero. A company's Admin connects their Xero
// organisation with OAuth; after that Drivo reads approved sales invoices
// into Ready for delivery. Drivo only reads from Xero.
//
// Settings (server only): XERO_CLIENT_ID, XERO_CLIENT_SECRET and
// XERO_WEBHOOK_KEY, from the app registered at developer.xero.com. The
// three URL settings exist so tests can point at a stand-in.

export const xeroEnv = {
  get clientId() { return process.env.XERO_CLIENT_ID ?? ""; },
  get clientSecret() { return process.env.XERO_CLIENT_SECRET ?? ""; },
  get webhookKey() { return process.env.XERO_WEBHOOK_KEY ?? ""; },
  get scopes() { return process.env.XERO_SCOPES || XERO_SCOPES; },
  get loginUrl() { return (process.env.XERO_LOGIN_URL || "https://login.xero.com").replace(/\/$/, ""); },
  get identityUrl() { return (process.env.XERO_IDENTITY_URL || "https://identity.xero.com").replace(/\/$/, ""); },
  get apiUrl() { return (process.env.XERO_API_URL || "https://api.xero.com").replace(/\/$/, ""); },
  get configured() { return Boolean(this.clientId && this.clientSecret); },
};

/** Ties Xero's answer to the Admin who started connecting. */
export const XERO_STATE_COOKIE = "drivo_xero_state";

export const xeroRedirectUri = (origin: string) => `${origin}/api/integrations/xero/callback`;

export function xeroAuthorizeUrl(origin: string, state: string): string {
  const url = new URL(`${xeroEnv.loginUrl}/identity/connect/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", xeroEnv.clientId);
  url.searchParams.set("redirect_uri", xeroRedirectUri(origin));
  url.searchParams.set("scope", xeroEnv.scopes);
  url.searchParams.set("state", state);
  return url.toString();
}

/** The site's own address, as the visitor reached it. */
export function requestOrigin(headers: Headers): string {
  return `${headers.get("x-forwarded-proto") ?? "https"}://${headers.get("x-forwarded-host") ?? headers.get("host")}`;
}

async function tokenRequest(params: Record<string, string>): Promise<XeroTokens> {
  const response = await fetch(`${xeroEnv.identityUrl}/connect/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${xeroEnv.clientId}:${xeroEnv.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !body.access_token || !body.refresh_token) {
    throw new XeroError(body.error === "invalid_grant" ? "reconnect" : "token", `Xero sign-in answered ${response.status}${body.error ? ` (${body.error})` : ""}`);
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + (body.expires_in ?? 1800) * 1000 };
}

export class XeroError extends Error {
  constructor(readonly kind: "reconnect" | "token" | "api" | "rate", message: string) {
    super(message);
  }
}

export const exchangeCode = (code: string, origin: string) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: xeroRedirectUri(origin) });
const refreshTokens = (refreshToken: string) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

async function api<T>(accessToken: string, path: string, init: { tenantId?: string; since?: string | null; method?: string } = {}): Promise<T> {
  const response = await fetch(`${xeroEnv.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init.tenantId ? { "Xero-tenant-id": init.tenantId } : {}),
      ...(init.since ? { "If-Modified-Since": new Date(init.since).toUTCString() } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  if (response.status === 429) throw new XeroError("rate", "Xero is limiting requests. Drivo will try again later.");
  if (response.status === 401 || response.status === 403) throw new XeroError("reconnect", `Xero refused the request (${response.status})`);
  if (!response.ok) throw new XeroError("api", `Xero answered ${response.status}`);
  return (response.status === 204 ? null : await response.json()) as T;
}

export type XeroConnection = { id: string; authEventId?: string; tenantId: string; tenantType: string; tenantName: string | null };

/** The organisations this sign-in can reach; the one just authorised carries the token's auth event id. */
export async function connectedOrganisation(tokens: XeroTokens): Promise<XeroConnection | null> {
  const all = (await api<XeroConnection[]>(tokens.access_token, "/connections")).filter((c) => c.tenantType === "ORGANISATION");
  const event = jwtClaim(tokens.access_token, "authentication_event_id");
  return all.find((c) => event && c.authEventId === event) ?? all[0] ?? null;
}

async function fetchInvoices(accessToken: string, tenantId: string, importFrom: string, since: string | null): Promise<XeroInvoice[]> {
  const out: XeroInvoice[] = [];
  for (let page = 1; page <= 30; page++) {
    const query = new URLSearchParams({
      where: `Type=="ACCREC"&&Date>=${xeroDate(importFrom)}`,
      Statuses: "AUTHORISED,PAID,VOIDED,DELETED",
      page: String(page),
    });
    const body = await api<{ Invoices?: XeroInvoice[] }>(accessToken, `/api.xro/2.0/Invoices?${query}`, { tenantId, since });
    const rows = body.Invoices ?? [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

async function fetchContacts(accessToken: string, tenantId: string, ids: string[]): Promise<Map<string, XeroContact>> {
  const out = new Map<string, XeroContact>();
  for (let i = 0; i < ids.length; i += 40) {
    const body = await api<{ Contacts?: XeroContact[] }>(accessToken, `/api.xro/2.0/Contacts?IDs=${ids.slice(i, i + 40).join(",")}`, { tenantId });
    for (const c of body.Contacts ?? []) out.set(c.ContactID, c);
  }
  return out;
}

type ConnectionRow = {
  tenant_id: string; xero_tenant_id: string; xero_connection_id: string | null; token_ciphertext: string;
  import_from: string; sync_started_at: string | null; last_sync_at: string | null;
};
const ROW = "tenant_id, xero_tenant_id, xero_connection_id, token_ciphertext, import_from, sync_started_at, last_sync_at";

/** Tokens that are good for at least another minute; refreshed and saved when they are not. */
async function freshTokens(admin: SupabaseClient, row: ConnectionRow): Promise<XeroTokens> {
  let tokens = decryptTokens(xeroEnv.clientSecret, row.token_ciphertext);
  if (tokens.expires_at - Date.now() < 60_000) {
    tokens = await refreshTokens(tokens.refresh_token);
    // Xero replaces the refresh token each time, so the new one is saved before anything else can fail.
    const { error } = await admin.from("xero_connections").update({ token_ciphertext: encryptTokens(xeroEnv.clientSecret, tokens) }).eq("tenant_id", row.tenant_id);
    if (error) throw new Error("Could not save the new Xero tokens");
  }
  return tokens;
}

export type SyncResult = { ok: true; stored: number; cancelled: number } | { ok: false; reason: "not_connected" | "busy" | "error"; message?: string };

/**
 * Read what changed in Xero since the last sync and store it. One sync per
 * company at a time; a second one within 90 seconds is skipped.
 */
export async function syncXero(admin: SupabaseClient, tenantId: string): Promise<SyncResult> {
  if (!xeroEnv.configured) return { ok: false, reason: "not_connected" };
  const { data } = await admin.from("xero_connections").select(ROW).eq("tenant_id", tenantId).maybeSingle();
  const row = data as ConnectionRow | null;
  if (!row) return { ok: false, reason: "not_connected" };
  if (row.sync_started_at && Date.now() - new Date(row.sync_started_at).getTime() < 90_000) return { ok: false, reason: "busy" };
  const startedAt = new Date().toISOString();
  await admin.from("xero_connections").update({ sync_started_at: startedAt, sync_requested_at: null }).eq("tenant_id", tenantId);

  try {
    const tokens = await freshTokens(admin, row);
    // Two minutes of overlap, so nothing changed during the last sync is missed.
    const since = row.last_sync_at ? new Date(new Date(row.last_sync_at).getTime() - 120_000).toISOString() : null;
    const invoices = await fetchInvoices(tokens.access_token, row.xero_tenant_id, row.import_from, since);

    // Phone and address come from the contact, fetched once for customers Drivo does not have yet.
    const contactIds = [...new Set(invoices.filter((i) => ["AUTHORISED", "PAID"].includes((i.Status ?? "").toUpperCase())).map((i) => i.Contact?.ContactID).filter((id): id is string => Boolean(id)))];
    let unknown = contactIds;
    if (contactIds.length) {
      const { data: known } = await admin.from("customers").select("xero_contact_id").eq("tenant_id", tenantId).in("xero_contact_id", contactIds);
      const have = new Set((known ?? []).map((k) => k.xero_contact_id as string));
      unknown = contactIds.filter((id) => !have.has(id));
    }
    const contacts = unknown.length ? await fetchContacts(tokens.access_token, row.xero_tenant_id, unknown) : new Map<string, XeroContact>();

    const mapped = invoices.map((i) => mapInvoice(i, row.import_from, contacts)).filter((i): i is IngestInvoice => i !== null);
    let stored = 0, cancelled = 0;
    for (let i = 0; i < mapped.length; i += 200) {
      const { data: result, error } = await admin.rpc("xero_ingest", { p_tenant_id: tenantId, p_invoices: mapped.slice(i, i + 200) });
      if (error) throw new Error(error.message);
      stored += (result as { stored: number }).stored;
      cancelled += (result as { cancelled: number }).cancelled;
    }
    await admin.from("xero_connections").update({ sync_started_at: null, last_sync_at: startedAt, last_sync_count: stored, last_error: null }).eq("tenant_id", tenantId);
    return { ok: true, stored, cancelled };
  } catch (e) {
    const message = e instanceof XeroError && e.kind === "reconnect"
      ? "Xero has stopped accepting this connection. Disconnect and connect Xero again."
      : String((e as Error).message ?? e).slice(0, 300);
    await admin.from("xero_connections").update({ sync_started_at: null, last_error: message }).eq("tenant_id", tenantId);
    return { ok: false, reason: "error", message };
  }
}

/** Sync every connected company (the daily job), or only those a webhook asked for. */
export async function syncAllXero(admin: SupabaseClient, onlyRequested = false) {
  if (!xeroEnv.configured) return { companies: 0, stored: 0, failed: 0 };
  let query = admin.from("xero_connections").select("tenant_id");
  if (onlyRequested) query = query.not("sync_requested_at", "is", null);
  const { data } = await query.limit(200);
  const results = { companies: 0, stored: 0, failed: 0 };
  for (const row of data ?? []) {
    const r = await syncXero(admin, row.tenant_id as string);
    results.companies++;
    if (r.ok) results.stored += r.stored;
    else if (r.reason === "error") results.failed++;
  }
  return results;
}

/** Remove the link at Xero (best effort) and in Drivo. Customers and invoices already brought in stay. */
export async function disconnectXero(admin: SupabaseClient, tenantId: string) {
  const { data } = await admin.from("xero_connections").select(ROW).eq("tenant_id", tenantId).maybeSingle();
  const row = data as ConnectionRow | null;
  if (!row) return;
  try {
    if (row.xero_connection_id && xeroEnv.configured) {
      const tokens = await freshTokens(admin, row);
      await api(tokens.access_token, `/connections/${encodeURIComponent(row.xero_connection_id)}`, { method: "DELETE" });
    }
  } catch {
    // The company can also remove Drivo under Connected apps in Xero.
  }
  await admin.from("xero_connections").delete().eq("tenant_id", tenantId);
}
