"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export async function sendReset(_prev: { sent?: boolean; error?: string } | undefined, formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter the email you sign in with." };
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const supabase = await createClient();
  // Same answer whether or not the email has an account, so the page does not reveal who uses Drivo.
  await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback?next=/account/password` });
  return { sent: true };
}
