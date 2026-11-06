import "server-only";
import { NextResponse } from "next/server";
import { linkSecret, verify } from "@/lib/hmac";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Checks a KaiTech webhook: signature with the link's secret, age, and
 * whether this delivery id was already processed. Returns the parsed body
 * and the tenant, or a response to send back.
 */
export async function checkWebhook(
  request: Request,
  { provider, masterSecret, orgField, tenantColumn }: { provider: "billzilla" | "kaiworkforce"; masterSecret: string; orgField: string; tenantColumn: "billzilla_org_id" | "kaiworkforce_company_id" },
): Promise<{ ok: true; body: Record<string, unknown>; tenantId: string; deliveryId: string; event: string } | { ok: false; response: NextResponse }> {
  const fail = (status: number, error: string) => ({ ok: false as const, response: NextResponse.json({ error }, { status }) });
  if (!masterSecret) return fail(503, "Integration is not configured");
  const raw = await request.text();
  if (raw.length > 1_000_000) return fail(413, "Body too large");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Body is not JSON");
  }
  const org = typeof body[orgField] === "string" ? (body[orgField] as string) : "";
  const result = verify(linkSecret(masterSecret, org), {
    timestamp: request.headers.get("x-kaitech-timestamp"),
    signature: request.headers.get("x-kaitech-signature"),
  }, raw);
  if (!result.ok) return fail(401, `Signature check failed: ${result.reason}`);

  const deliveryId = request.headers.get("x-kaitech-delivery") ?? "";
  const event = request.headers.get("x-kaitech-event") ?? String(body.event ?? "");
  if (!deliveryId) return fail(400, "Missing X-KaiTech-Delivery");

  const admin = createAdminClient();
  const { data: tenant } = await admin.from("tenants").select("id").eq(tenantColumn, org).maybeSingle();
  if (!tenant) return fail(404, "Unknown organisation");
  const { error } = await admin.from("integration_deliveries").insert({ tenant_id: tenant.id, provider, delivery_id: deliveryId, event });
  if (error?.code === "23505") return { ok: false, response: NextResponse.json({ result: "duplicate" }, { status: 200 }) };
  if (error) return fail(500, "Could not record the delivery");
  return { ok: true, body, tenantId: tenant.id, deliveryId, event };
}
