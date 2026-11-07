import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getContext } from "@/lib/tenant";
import { DriverApp } from "./DriverApp";

export const metadata: Metadata = { title: "Driver" };
export const dynamic = "force-dynamic";

/**
 * The driver app in the browser, for phones without the Drivo app (for
 * example an iPhone before TestFlight). Location is shared only while this
 * page is open, so the installed app stays the better choice.
 */
export default async function DriverPage() {
  const ctx = await getContext();
  const driver = ctx.memberships.find((m) => m.role === "driver");
  if (!driver) redirect(ctx.isManager ? "/" : "/no-access");
  return (
    <DriverApp
      userId={ctx.userId}
      tenantId={driver.tenant_id}
      tenantName={driver.tenant.name}
      driverName={driver.full_name}
      timeZone={driver.tenant.time_zone}
    />
  );
}
