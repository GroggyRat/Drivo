import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { XERO_STATE_COOKIE, requestOrigin, xeroAuthorizeUrl, xeroEnv } from "@/lib/integrations/xero";
import { getContext } from "@/lib/tenant";

export const dynamic = "force-dynamic";

// Step 1 of connecting Xero: an Owner or Admin is sent to Xero to sign in and
// choose their organisation. The state cookie ties Xero's answer to this
// person and company. It lasts an hour, because a first sign-in to Xero (password,
// two-step code, choosing the organisation) can easily take more than ten minutes.
export async function GET(request: Request) {
  const ctx = await getContext();
  const origin = requestOrigin(request.headers);
  const settings = (params: Record<string, string>) => NextResponse.redirect(`${origin}/settings?${new URLSearchParams({ tab: "integrations", ...params })}`);
  if (!ctx.isAdmin || !ctx.tenant) return settings({ error: "Only an Owner or Admin can connect Xero." });
  if (!xeroEnv.configured) return settings({ error: "Xero is not set up on this Drivo yet. Ask KaiTech." });
  const state = randomBytes(24).toString("base64url");
  const response = NextResponse.redirect(xeroAuthorizeUrl(origin, state));
  response.cookies.set(XERO_STATE_COOKIE, `${state}.${ctx.tenant.id}`, { httpOnly: true, secure: origin.startsWith("https"), sameSite: "lax", maxAge: 3600, path: "/api/integrations/xero" });
  return response;
}
