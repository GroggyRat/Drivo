import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { publicEnv } from "@/lib/env";
import type { LngLat } from "@/lib/geo";
import { serverEnv } from "@/lib/server-env";
import { loadRoadGraph, type Path } from "@/lib/routing/graph";
import { osrmResponse } from "@/lib/routing/osrm";

// Turn-by-turn for the driver app (Ferrostar's Valhalla adapter). The
// driver's Supabase token is checked here. The route comes from Drivo's own
// road graph, or from a separate routing server (with the server-side key,
// which phones never see) when one is configured.
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
  const body = await request.text();
  if (body.length > 200_000) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  if (!serverEnv.routingApiUrl || !serverEnv.routingApiKey) return fromRoadGraph(body);
  const upstream = await fetch(`${serverEnv.routingApiUrl.replace(/\/$/, "")}/v1/navigation/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serverEnv.routingApiKey}` },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

const noStore = { "Cache-Control": "no-store" };

/** Answers Ferrostar's Valhalla request ({ locations: [{ lat, lon }, ...] }) from the road graph. */
function fromRoadGraph(body: string) {
  const graph = loadRoadGraph();
  if (!graph) return NextResponse.json({ code: "NoRoute", message: "Road data is not available" }, { status: 503, headers: noStore });
  let locations: LngLat[];
  try {
    const parsed = JSON.parse(body) as { locations?: { lat: number; lon: number }[] };
    locations = (parsed.locations ?? []).map((l) => [Number(l.lon), Number(l.lat)] as LngLat);
  } catch {
    return NextResponse.json({ code: "InvalidInput", message: "Send a Valhalla route request" }, { status: 400, headers: noStore });
  }
  if (locations.length < 2 || locations.length > 25 || locations.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat))) {
    return NextResponse.json({ code: "InvalidInput", message: "Send between 2 and 25 locations" }, { status: 400, headers: noStore });
  }
  // The driver may be in a yard or car park, so allow a longer way to the road at the start.
  const snaps = locations.map((p, i) => graph.snap(p, i === 0 ? 5000 : 2000));
  if (snaps.some((s) => !s)) {
    return NextResponse.json({ code: "NoSegment", message: "A location is too far from any road" }, { status: 400, headers: noStore });
  }
  const paths: Path[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const p = graph.finish(graph.search(snaps[i - 1]!, "time"), snaps[i]!);
    if (!p) return NextResponse.json({ code: "NoRoute", message: "There is no road to this stop from here" }, { status: 400, headers: noStore });
    paths.push(p);
  }
  return NextResponse.json(osrmResponse(graph, paths, snaps.map((s) => s!.point)), { headers: noStore });
}
