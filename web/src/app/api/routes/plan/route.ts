import { NextResponse } from "next/server";
import { z } from "zod";
import { loadPlanInputs, toPlanRequest, withFuel, OBJECTIVE_ORDER } from "@/lib/planning";
import { getRoutingProvider } from "@/lib/routing";
import { getContext } from "@/lib/tenant";

const body = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(150),
  depotId: z.string().uuid(),
  vehicleId: z.string().uuid().nullish(),
  departureAt: z.string().datetime({ offset: true }),
});

// Three options (lowest fuel, fastest, shortest) for the selected invoices.
export async function POST(request: Request) {
  const ctx = await getContext();
  if (!ctx.isManager || !ctx.tenant) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const parsed = body.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Choose invoices, a depot and a departure time" }, { status: 400 });
  try {
    const inputs = await loadPlanInputs(ctx.supabase, ctx.tenant, parsed.data);
    const provider = getRoutingProvider();
    const options = await provider.plan(toPlanRequest(inputs, parsed.data.departureAt), OBJECTIVE_ORDER);
    return NextResponse.json({ source: provider.source, depot: inputs.depot, stops: inputs.stops, options: options.map((o) => withFuel(o, inputs)) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
