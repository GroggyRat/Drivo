import { NextResponse } from "next/server";
import { buildLiveSnapshot } from "@/lib/live";
import { getContext } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await getContext();
  if (!ctx.isManager || !ctx.tenant) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  return NextResponse.json(await buildLiveSnapshot(ctx.supabase, ctx.tenant));
}
