// Formatting for the UI. Dates are DD/MM/YYYY in the tenant's time zone.

export const DEFAULT_TZ = "Pacific/Fiji";

function parts(value: string | Date, timeZone: string, options: Intl.DateTimeFormatOptions) {
  const date = typeof value === "string" ? new Date(value) : value;
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).formatToParts(date).map((p) => [p.type, p.value]),
  );
}

export function formatDate(value: string | Date | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-");
    return `${d}/${m}/${y}`;
  }
  const p = parts(value, timeZone, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.day}/${p.month}/${p.year}`;
}

export function formatTime(value: string | Date | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!value) return "";
  const p = parts(value, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.hour}:${p.minute}`;
}

export function formatDateTime(value: string | Date | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!value) return "";
  return `${formatDate(value, timeZone)} ${formatTime(value, timeZone)}`;
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(timeZone = DEFAULT_TZ, offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  const p = parts(date, timeZone, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatDistance(metres: number | null | undefined): string {
  if (metres == null) return "";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatLitres(litres: number | null | undefined): string {
  if (litres == null) return "";
  return `${Number(litres).toFixed(1)} L`;
}

export function formatMoney(amount: number | string | null | undefined, currency = "FJD"): string {
  if (amount == null || amount === "") return "";
  return `${currency} ${Number(amount).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatSpeed(kmh: number | string | null | undefined): string {
  if (kmh == null) return "";
  return `${Math.round(Number(kmh))} km/h`;
}

/** Plain words for statuses. */
export const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  planned: "Planned",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  partially_delivered: "Part delivered",
  failed: "Not delivered",
  cancelled: "Cancelled",
  draft: "Draft",
  sent: "Sent",
  in_progress: "In progress",
  completed: "Completed",
  scheduled: "Scheduled",
  arrived: "Arrived",
  skipped: "Skipped",
  pending: "Needs review",
  approved: "Approved",
  rejected: "Rejected",
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export type Tone = "green" | "red" | "amber" | "grey" | "blue";

/** Badge colour: green delivered or moving, red over limit or failed, amber needs review or waiting, grey scheduled. */
export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case "delivered":
    case "completed":
    case "approved":
    case "moving":
      return "green";
    case "failed":
    case "rejected":
    case "cancelled":
    case "over_limit":
      return "red";
    case "pending":
    case "partially_delivered":
    case "needs_pin":
    case "waiting":
      return "amber";
    case "in_progress":
    case "out_for_delivery":
    case "sent":
    case "arrived":
      return "blue";
    default:
      return "grey";
  }
}
