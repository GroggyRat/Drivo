import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/server-env";
import { createAdminClient } from "@/lib/supabase/admin";

// Nightly (vercel.json): stops tracking drivers who clocked in in the app and
// forgot to clock out, 16 hours after clock-in.
export async function GET(request: Request) {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${serverEnv.cronSecret}`);
  if (!serverEnv.cronSecret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  }
  const { data, error } = await createAdminClient().rpc("close_forgotten_shifts");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ closed: data });
}
