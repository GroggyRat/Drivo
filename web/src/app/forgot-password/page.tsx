import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import Link from "next/link";
import { ResetForm } from "./ResetForm";

export const metadata: Metadata = { title: "Reset password" };

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <Logo size={36} />
          <h1 className="mt-4 text-2xl font-semibold">Reset your password</h1>
          <p className="mt-1 text-muted">We will email you a link to choose a new password.</p>
        </div>
        {error === "expired" && <p className="mb-4 rounded-[var(--radius-control)] bg-warn-bg px-3 py-2 text-sm text-warn">That link has expired or was already used. Ask for a new one.</p>}
        <div className="card p-5"><ResetForm /></div>
        <p className="mt-4 text-sm"><Link href="/sign-in" className="link">Back to sign in</Link></p>
      </div>
    </main>
  );
}
