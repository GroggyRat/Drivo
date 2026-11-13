import { after } from "next/server";
import { syncAllXero, xeroEnv } from "@/lib/integrations/xero";
import { validXeroSignature } from "@/lib/integrations/xero-core";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Xero to Drivo: "something changed in this organisation". Xero wants an
// empty 200 within five seconds for a correctly signed request and a 401 for
// anything else (it tests both when the webhook is set up), so the request
// only marks the companies and the sync itself runs after the answer.
export async function POST(request: Request) {
  const raw = await request.text();
  if (!validXeroSignature(xeroEnv.webhookKey, raw, request.headers.get("x-xero-signature"))) {
    return new Response(null, { status: 401 });
  }
  let orgs: string[] = [];
  try {
    const body = JSON.parse(raw) as { events?: { tenantId?: string; eventCategory?: string }[] };
    orgs = [...new Set((body.events ?? []).filter((e) => !e.eventCategory || ["INVOICE", "CONTACT"].includes(e.eventCategory)).map((e) => e.tenantId).filter((t): t is string => Boolean(t)))];
  } catch {
    // A signed body that is not JSON: nothing to do.
  }
  if (orgs.length) {
    const admin = createAdminClient();
    await admin.from("xero_connections").update({ sync_requested_at: new Date().toISOString() }).in("xero_tenant_id", orgs.slice(0, 100));
    after(async () => {
      await syncAllXero(admin, true);
    });
  }
  return new Response(null, { status: 200 });
}
