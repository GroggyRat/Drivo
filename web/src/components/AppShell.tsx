"use client";

import Link from "next/link";
import { LogoMark } from "./Logo";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { IconInvoice, IconLedger, IconLive, IconPin, IconPlan, IconRoute, IconSettings, IconSignOut } from "./icons";

const NAV = [
  { href: "/", label: "Live operations", icon: IconLive },
  { href: "/plan", label: "Plan route", icon: IconPlan },
  { href: "/routes", label: "Routes", icon: IconRoute },
  { href: "/orders", label: "Ready for delivery", icon: IconInvoice },
  { href: "/locations", label: "Locations", icon: IconPin },
  { href: "/deliveries", label: "Deliveries", icon: IconLedger },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

export function AppShell({ tenantName, userName, roleLabel, tenantSwitcher, platformLink, children }: {
  tenantName: string;
  userName: string;
  roleLabel: string;
  tenantSwitcher?: ReactNode;
  platformLink?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className="min-h-screen lg:flex">
      <aside className="border-b border-line bg-navy text-white lg:fixed lg:inset-y-0 lg:w-60 lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between gap-3 px-4 py-3 lg:block lg:px-5 lg:py-5">
          <div>
            <p className="text-lg font-semibold tracking-tight">{tenantName}</p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-[#c7d2e4]"><LogoMark size={16} />Drivo</p>
          </div>
          <div className="lg:hidden">
            <form action="/auth/sign-out" method="post">
              <button className="btn btn-sm border border-white/30 text-white" type="submit">Sign out</button>
            </form>
          </div>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:px-3">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href) ? "page" : undefined}
              className={`flex min-h-10 items-center gap-2.5 rounded-[var(--radius-control)] px-3 text-sm font-medium whitespace-nowrap ${
                isActive(href) ? "bg-white/15 text-white" : "text-[#d6deeb] hover:bg-white/10 hover:text-white"
              }`}
            >
              <Icon />
              {label}
            </Link>
          ))}
          {platformLink && (
            <Link href="/platform" className="flex min-h-10 items-center gap-2.5 rounded-[var(--radius-control)] px-3 text-sm font-medium whitespace-nowrap text-[#d6deeb] hover:bg-white/10 hover:text-white lg:mt-3 lg:border-t lg:border-white/15 lg:pt-3">
              <IconSettings /> Platform console
            </Link>
          )}
        </nav>
        <div className="hidden px-5 py-4 lg:absolute lg:inset-x-0 lg:bottom-0 lg:block">
          {tenantSwitcher}
          <p className="mt-3 text-sm font-medium">{userName}</p>
          <p className="text-xs text-[#c7d2e4]">{roleLabel}</p>
          <Link href="/account/password" className="mt-1 block text-xs text-[#d6deeb] underline-offset-2 hover:underline">Change password</Link>
          <form action="/auth/sign-out" method="post" className="mt-3">
            <button className="btn btn-sm w-full border border-white/30 text-white hover:bg-white/10" type="submit">
              <IconSignOut /> Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:ml-60 lg:px-8 lg:py-7">{children}</main>
    </div>
  );
}
