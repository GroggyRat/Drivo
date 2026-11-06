import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getBillzillaClient } from "@/lib/integrations/billzilla";
import { sendDueOutbox } from "@/lib/integrations/outbox";
import { serverEnv } from "@/lib/server-env";
import { createAdminClient } from "@/lib/supabase/admin";

// Sends queued delivery updates to BillZilla. Called every few minutes by
// Vercel Cron (vercel.json) with Authorization: Bearer <CRON_SECRET>.
export async function GET(request: Request) {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${serverEnv.cronSecret}`);
  if (!serverEnv.cronSecret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  }
  const results = await sendDueOutbox(createAdminClient(), getBillzillaClient());
  return NextResponse.json(results);
}
