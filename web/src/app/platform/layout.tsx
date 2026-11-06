import type { Metadata } from "next";
import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/tenant";

export const metadata: Metadata = { title: { default: "Platform console", template: "%s | Drivo platform" } };

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePlatformAdmin();
  return (
    <div className="min-h-screen">
      <header className="bg-navy text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div>
            <p className="text-xs tracking-wide text-[#c7d2e4] uppercase">KaiTech</p>
            <Link href="/platform" className="text-lg font-semibold">Drivo platform console</Link>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[#d6deeb]">{ctx.platformName ?? "Platform owner"}</span>
            {ctx.isManager && <Link href="/" className="btn btn-sm border border-white/30 text-white hover:bg-white/10">Company workspace</Link>}
            <form action="/auth/sign-out" method="post">
              <button className="btn btn-sm border border-white/30 text-white hover:bg-white/10" type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
