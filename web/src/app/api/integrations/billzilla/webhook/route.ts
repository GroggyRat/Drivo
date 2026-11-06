import { NextResponse } from "next/server";
import { billzillaWebhook } from "@/lib/integrations/schemas";
import { checkWebhook } from "@/lib/integrations/webhook";
import { serverEnv } from "@/lib/server-env";
import { createAdminClient } from "@/lib/supabase/admin";

// BillZilla to Drivo: invoice.confirmed, invoice.cancelled, customer.updated.
// See docs/integrations.md.
export async function POST(request: Request) {
  const checked = await checkWebhook(request, {
    provider: "billzilla",
    masterSecret: serverEnv.billzillaWebhookSecret,
    orgField: "organisation_id",
    tenantColumn: "billzilla_org_id",
  });
  if (!checked.ok) return checked.response;
  const parsed = billzillaWebhook.safeParse(checked.body);
  const admin = createAdminClient();
  if (!parsed.success) {
    await admin.from("integration_deliveries").delete().eq("provider", "billzilla").eq("delivery_id", checked.deliveryId);
    return NextResponse.json({ error: "Payload does not match docs/integrations.md", issues: parsed.error.issues.slice(0, 5) }, { status: 422 });
  }
  const { data, error } = await admin.rpc("billzilla_ingest", {
    p_organisation_id: parsed.data.organisation_id,
    p_event: parsed.data.event,
    p_payload: parsed.data,
  });
  if (error) {
    // Let BillZilla retry this delivery.
    await admin.from("integration_deliveries").delete().eq("provider", "billzilla").eq("delivery_id", checked.deliveryId);
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  return NextResponse.json(data);
}
