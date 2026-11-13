import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { serverEnv } from "@/lib/server-env";

/**
 * Service role client. It bypasses Row Level Security. Use it only in server
 * code, and only for: integration webhooks and the outbox, creating sign-in
 * accounts for new people, signing proof of delivery links for BillZilla, and
 * keeping each company's Xero connection (tokens and synced invoices).
 */
export function createAdminClient() {
  return createClient(publicEnv.supabaseUrl, serverEnv.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
