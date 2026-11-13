import type { Metadata } from "next";
import { buildLiveSnapshot } from "@/lib/live";
import { formatDate } from "@/lib/format";
import { requireManager } from "@/lib/tenant";
import { PageHeader } from "@/components/ui";
import { LiveOps } from "./LiveOps";

export const metadata: Metadata = { title: "Live operations" };
export const dynamic = "force-dynamic";

export default async function LivePage() {
  const ctx = await requireManager();
  const snapshot = await buildLiveSnapshot(ctx.supabase, ctx.tenant);
  return (
    <>
      <PageHeader title="Live operations" description={`Today, ${formatDate(new Date(), ctx.tenant.time_zone)}. Updates every few seconds.`} />
      <LiveOps initial={snapshot} tenantId={ctx.tenant.id} timeZone={ctx.tenant.time_zone} roadAlerts={ctx.tenant.road_alerts_enabled} />
    </>
  );
}
