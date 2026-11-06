import { NextResponse } from "next/server";
import { z } from "zod";
import { loadPlanInputs, toPlanRequest, withFuel } from "@/lib/planning";
import { getRoutingProvider } from "@/lib/routing";
import { getContext } from "@/lib/tenant";

const body = z.object({
  keys: z.array(z.string()).min(1).max(150),
  depotId: z.string().uuid(),
  vehicleId: z.string().uuid().nullish(),
  departureAt: z.string().datetime({ offset: true }),
  objective: z.enum(["lowest_fuel", "fastest", "shortest"]),
});

// Times, distance and fuel for stops in the order the dispatcher chose.
export async function POST(request: Request) {
  const ctx = await getContext();
  if (!ctx.isManager || !ctx.tenant) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const parsed = body.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid stop order" }, { status: 400 });
  const { keys, depotId, vehicleId, departureAt, objective } = parsed.data;
  try {
    const orderIds = keys.filter((k) => !k.startsWith("loc:"));
    const locationIds = keys.filter((k) => k.startsWith("loc:")).map((k) => k.slice(4));
    const inputs = await loadPlanInputs(ctx.supabase, ctx.tenant, { orderIds, locationIds, depotId, vehicleId });
    const provider = getRoutingProvider();
    const option = await provider.sequence(toPlanRequest(inputs, departureAt, keys), objective);
    return NextResponse.json({ source: provider.source, stops: inputs.stops, option: withFuel(option, inputs) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
