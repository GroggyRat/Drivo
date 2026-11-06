import { NextResponse } from "next/server";
import { kaiworkforceWebhook } from "@/lib/integrations/schemas";
import { checkWebhook } from "@/lib/integrations/webhook";
import { serverEnv } from "@/lib/server-env";
import { createAdminClient } from "@/lib/supabase/admin";

// KaiWorkforce to Drivo: shift.clock_in and shift.clock_out start and stop
// tracking. The driver app is told through the tenant's Realtime channel
// (and by push notification once the app registers for it).
export async function POST(request: Request) {
  const checked = await checkWebhook(request, {
    provider: "kaiworkforce",
    masterSecret: serverEnv.kaiworkforceWebhookSecret,
    orgField: "company_id",
    tenantColumn: "kaiworkforce_company_id",
  });
  if (!checked.ok) return checked.response;
  const parsed = kaiworkforceWebhook.safeParse(checked.body);
  const admin = createAdminClient();
  if (!parsed.success) {
    await admin.from("integration_deliveries").delete().eq("provider", "kaiworkforce").eq("delivery_id", checked.deliveryId);
    return NextResponse.json({ error: "Payload does not match docs/integrations.md" }, { status: 422 });
  }
  const p = parsed.data;
  const { data, error } = await admin.rpc("kaiworkforce_clock", {
    p_company_id: p.company_id, p_employee_id: p.employee_id, p_event: p.event, p_shift_id: p.shift_id, p_at: p.at,
  });
  if (error) {
    await admin.from("integration_deliveries").delete().eq("provider", "kaiworkforce").eq("delivery_id", checked.deliveryId);
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  const result = data as { result: string; driver_id?: string };
  if (result.driver_id && (result.result === "opened" || result.result === "closed")) {
    await admin.channel(`tenant:${checked.tenantId}`).send({
      type: "broadcast",
      event: "shift",
      payload: { driver_id: result.driver_id, tracking: result.result === "opened" },
    });
  }
  return NextResponse.json(result);
}
