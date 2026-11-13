import type { Tone } from "@/lib/format";

/** One company in platform_billing: what it pays a month, when it is next due and what is owed now. */
export type BillingRow = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  monthly_fee: number;
  road_alerts_enabled: boolean;
  monthly_total: number;
  next_due_on: string | null;
  days_until_due: number | null;
  months_due: number;
  amount_due: number;
  last_paid_on: string | null;
  last_paid_amount: number | null;
};

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** "Overdue by 12 days", "Due today", "Due in 5 days", or why nothing is due. */
export function dueLabel(b: BillingRow): { text: string; tone: Tone } {
  if (Number(b.monthly_total) === 0) return { text: "No charge", tone: "grey" };
  if (b.days_until_due == null) return { text: "Due date not set", tone: "amber" };
  if (b.days_until_due < 0) return { text: `Overdue by ${days(-b.days_until_due)}`, tone: "red" };
  if (b.days_until_due === 0) return { text: "Due today", tone: "amber" };
  if (b.days_until_due <= 7) return { text: `Due in ${days(b.days_until_due)}`, tone: "amber" };
  return { text: `Due in ${days(b.days_until_due)}`, tone: "green" };
}
