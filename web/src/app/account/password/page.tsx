import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PasswordForm } from "./PasswordForm";

export const metadata: Metadata = { title: "Choose a password" };
export const dynamic = "force-dynamic";

// Used after a reset link, and by anyone signed in who wants a new password
// (for example after receiving a temporary one).
export default async function PasswordPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/forgot-password?error=expired");
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <Logo size={36} />
          <h1 className="mt-4 text-2xl font-semibold">Choose a password</h1>
          <p className="mt-1 text-muted">For {data.user.email}</p>
        </div>
        <div className="card p-5"><PasswordForm /></div>
      </div>
    </main>
  );
}
