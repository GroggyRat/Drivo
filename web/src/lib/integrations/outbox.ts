import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillzillaClient } from "./billzilla";
import type { DeliveryUpdate } from "./schemas";

// Sends queued delivery updates to BillZilla. Runs from the cron endpoint
// and right after a delivery is completed. Retries back off: 1 min, 5 min,
// 30 min, 2 h, 12 h, then the message is marked failed for an Admin to see.

const BACKOFF_S = [60, 300, 1800, 7200, 43200];
const PROOF_LINK_DAYS = 30;

type OutboxRow = {
  id: string;
  tenant_id: string;
  event: string;
  target_id: string;
  attempts: number;
  payload: Record<string, unknown>;
};

export async function sendDueOutbox(admin: SupabaseClient, client: BillzillaClient, limit = 25) {
  const { data: rows, error } = await admin
    .from("integration_outbox")
    .select("id, tenant_id, event, target_id, attempts, payload")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at")
    .limit(limit);
  if (error) throw error;

  const results = { sent: 0, retried: 0, failed: 0 };
  for (const row of (rows ?? []) as OutboxRow[]) {
    try {
      const { data: tenant } = await admin.from("tenants").select("billzilla_org_id").eq("id", row.tenant_id).single();
      if (!tenant?.billzilla_org_id) throw new Error("Tenant is not linked to BillZilla");
      const sign = async (path: unknown) => {
        if (typeof path !== "string" || !path) return null;
        const { data } = await admin.storage.from("delivery-proofs").createSignedUrl(path, PROOF_LINK_DAYS * 86400);
        return data?.signedUrl ?? null;
      };
      const p = row.payload;
      const update: DeliveryUpdate = {
        event: "delivery.updated",
        organisation_id: tenant.billzilla_org_id,
        invoice_id: row.target_id,
        status: p.status as DeliveryUpdate["status"],
        delivered_at: (p.delivered_at as string) ?? null,
        received_by: (p.received_by as string) ?? null,
        delivered_in_full: Boolean(p.delivered_in_full),
        notes: (p.notes as string) ?? null,
        driver_name: (p.driver_name as string) ?? null,
        vehicle_plate: (p.vehicle_plate as string) ?? null,
        proof: {
          photo_url: await sign(p.photo_path),
          signature_url: await sign(p.signature_path),
          expires_at: new Date(Date.now() + PROOF_LINK_DAYS * 86400_000).toISOString(),
        },
      };
      await client.pushDelivery(tenant.billzilla_org_id, update);
      await admin.from("integration_outbox").update({ status: "sent", sent_at: new Date().toISOString(), attempts: row.attempts + 1, last_error: null }).eq("id", row.id);
      results.sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const giveUp = attempts > BACKOFF_S.length;
      await admin
        .from("integration_outbox")
        .update({
          attempts,
          status: giveUp ? "failed" : "pending",
          last_error: String((e as Error).message ?? e).slice(0, 500),
          next_attempt_at: new Date(Date.now() + (BACKOFF_S[attempts - 1] ?? 0) * 1000).toISOString(),
        })
        .eq("id", row.id);
      if (giveUp) results.failed++;
      else results.retried++;
    }
  }
  return results;
}
