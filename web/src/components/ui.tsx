import Link from "next/link";
import type { ReactNode } from "react";
import { statusLabel, statusTone, type Tone } from "@/lib/format";
import { IconAlert, IconCheck, IconX } from "./icons";

const TONE: Record<Tone, string> = {
  green: "bg-ok-bg text-ok",
  red: "bg-bad-bg text-bad",
  amber: "bg-warn-bg text-warn",
  grey: "bg-neutral-bg text-neutral",
  blue: "bg-info-bg text-info",
};

export function Badge({ tone = "grey", children, icon }: { tone?: Tone; children: ReactNode; icon?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[tone]}`}>
      {icon && tone === "green" && <IconCheck width={12} height={12} />}
      {icon && tone === "red" && <IconX width={12} height={12} />}
      {icon && tone === "amber" && <IconAlert width={12} height={12} />}
      {children}
    </span>
  );
}

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  const tone = statusTone(status);
  return (
    <Badge tone={tone} icon={tone === "green" || tone === "red"}>
      {label ?? statusLabel(status)}
    </Badge>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {description && <p className="mt-1 text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = "", bodyClassName = "p-4" }: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card min-w-0 ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function StatCard({ label, value, detail, tone }: { label: string; value: ReactNode; detail?: ReactNode; tone?: Tone }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone === "red" ? "text-bad" : "text-ink"}`}>{value}</p>
      {detail && <p className="mt-1 text-xs text-muted">{detail}</p>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Notice({ tone = "blue", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`rounded-[var(--radius-control)] px-3 py-2 text-sm ${TONE[tone]}`}>{children}</div>;
}

export function Tabs({ tabs, current }: { tabs: { href: string; label: string; key: string; count?: number }[]; current: string }) {
  return (
    <nav aria-label="Sections" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${
            t.key === current ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"
          }`}
        >
          {t.label}
          {t.count != null && <span className="ml-1.5 rounded-full bg-neutral-bg px-1.5 text-xs text-neutral">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="relative overflow-x-auto">{children}</div>;
}
