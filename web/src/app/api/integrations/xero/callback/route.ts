import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { XERO_STATE_COOKIE, connectedOrganisation, exchangeCode, requestOrigin, syncXero, xeroEnv } from "@/lib/integrations/xero";
import { encryptTokens } from "@/lib/integrations/xero-core";
import { todayIn } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { getContext } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** Invoices dated from this many days before connecting are brought in. */
const IMPORT_BACK_DAYS = 3;

// Step 2 of connecting Xero: Xero sends the Admin back with a code. The code
// is swapped for tokens, which are encrypted and stored by the server; the
// service role is used because no person may write this table.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = requestOrigin(request.headers);
  const settings = (params: Record<string, string>) => {
    const response = NextResponse.redirect(`${origin}/settings?${new URLSearchParams({ tab: "integrations", ...params })}`);
    response.cookies.delete({ name: XERO_STATE_COOKIE, path: "/api/integrations/xero" });
    return response;
  };

  const ctx = await getContext();
  if (!ctx.isAdmin || !ctx.tenant) return settings({ error: "Only an Owner or Admin can connect Xero." });
  if (url.searchParams.get("error")) return settings({ error: "Xero was not connected: access was not given." });

  const cookie = request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${XERO_STATE_COOKIE}=`))?.split("=")[1] ?? "";
  const [expected, tenantId] = decodeURIComponent(cookie).split(".");
  const given = Buffer.from(url.searchParams.get("state") ?? "");
  const code = url.searchParams.get("code");
  if (!expected || !code || given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected)) || tenantId !== ctx.tenant.id) {
    return settings({ error: "That Xero sign-in took too long or was started in another tab, so it could not be matched. Click Connect Xero again and finish in the same tab." });
  }

  try {
    const tokens = await exchangeCode(code, origin);
    const org = await connectedOrganisation(tokens);
    if (!org) return settings({ error: "No Xero organisation was chosen. Try again and pick your organisation." });
    const admin = createAdminClient();
    const { data: taken } = await admin.from("xero_connections").select("tenant_id").eq("xero_tenant_id", org.tenantId).neq("tenant_id", ctx.tenant.id).maybeSingle();
    if (taken) return settings({ error: `${org.tenantName ?? "That Xero organisation"} is already connected to another company in Drivo.` });
    const { error } = await admin.from("xero_connections").upsert({
      tenant_id: ctx.tenant.id,
      xero_tenant_id: org.tenantId,
      xero_connection_id: org.id,
      org_name: (org.tenantName ?? "Xero organisation").slice(0, 200),
      token_ciphertext: encryptTokens(xeroEnv.clientSecret, tokens),
      import_from: todayIn(ctx.tenant.time_zone, -IMPORT_BACK_DAYS),
      connected_by: ctx.userId,
      connected_at: new Date().toISOString(),
      last_sync_at: null,
      last_sync_count: null,
      last_error: null,
      sync_started_at: null,
    });
    if (error) return settings({ error: "Xero answered, but the connection could not be saved." });
    const first = await syncXero(admin, ctx.tenant.id);
    return settings({ notice: "xero-connected", ...(first.ok ? { count: String(first.stored) } : {}) });
  } catch {
    return settings({ error: "Xero could not be connected. Try again in a minute." });
  }
}
