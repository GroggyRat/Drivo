import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { publicEnv } from "@/lib/env";
import { serverEnv } from "@/lib/server-env";

// Turn-by-turn for the driver app (Ferrostar's Valhalla adapter). The
// driver's Supabase token is checked here; the request then goes to the
// routing server with the server-side key, which phones never see.
export async function POST(request: Request) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const supabase = createClient(publicEnv.supabaseUrl, publicEnv.supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: user } = await supabase.auth.getUser(token);
  if (!user.user) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const { data: driver } = await supabase.from("memberships").select("tenant_id").eq("user_id", user.user.id).eq("role", "driver").eq("active", true).limit(1);
  if (!driver?.length) return NextResponse.json({ error: "Drivers only" }, { status: 403 });
  if (!serverEnv.routingApiUrl || !serverEnv.routingApiKey) {
    return NextResponse.json({ error: "The routing server is not connected" }, { status: 503 });
  }
  const body = await request.text();
  if (body.length > 200_000) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const upstream = await fetch(`${serverEnv.routingApiUrl.replace(/\/$/, "")}/v1/navigation/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serverEnv.routingApiKey}` },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
