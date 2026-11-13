import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getBillzillaClient } from "@/lib/integrations/billzilla";
import { sendDueOutbox } from "@/lib/integrations/outbox";
import { syncAllXero } from "@/lib/integrations/xero";
import { serverEnv } from "@/lib/server-env";
import { createAdminClient } from "@/lib/supabase/admin";

// Sends queued delivery updates to BillZilla and syncs Xero. Called by
// Vercel Cron (vercel.json) with Authorization: Bearer <CRON_SECRET>.
export async function GET(request: Request) {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${serverEnv.cronSecret}`);
  if (!serverEnv.cronSecret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  }
  const admin = createAdminClient();
  const results = await sendDueOutbox(admin, getBillzillaClient());
  // The same daily run checks Xero for every connected company. It catches
  // anything a webhook missed and keeps each connection from expiring.
  const xero = await syncAllXero(admin).catch(() => ({ companies: 0, stored: 0, failed: 1 }));
  return NextResponse.json({ ...results, xero });
}
