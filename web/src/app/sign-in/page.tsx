import type { Metadata } from "next";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <p className="text-sm font-semibold tracking-wide text-navy uppercase">Drivo</p>
          <h1 className="mt-1 text-2xl font-semibold">Sign in</h1>
          <p className="mt-1 text-muted">Delivery planning and fleet tracking. Use the email your company added you with.</p>
        </div>
        <div className="card p-5">
          <SignInForm next={next && next.startsWith("/") && !next.startsWith("//") ? next : "/"} />
        </div>
        <p className="mt-4 text-xs text-muted">Drivers sign in on the Drivo app on their phone.</p>
      </div>
    </main>
  );
}
