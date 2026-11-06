"use server";

import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/tenant";

export async function acknowledgeAlert(id: string) {
  const ctx = await requireManager();
  const { error } = await ctx.supabase.rpc("acknowledge_speed_event", { p_event_id: id });
  if (error) return { error: "Could not acknowledge this alert. Try again." };
  revalidatePath("/");
  return { ok: true };
}
