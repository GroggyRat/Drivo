"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistance, formatTime } from "@/lib/format";
import { haversine, type LngLat } from "@/lib/geo";
import { ROAD_ALERT_KINDS, ROAD_ALERT_LABEL, type RoadAlert, type RoadAlertKind } from "@/lib/road-alerts";
import { getBrowserClient } from "@/lib/supabase/client";

/** Warn about an alert from this far away. */
const WARN_M = 600;

/**
 * Road alerts for the driver page: loads the open alerts around the driver,
 * and reports, confirms and clears them. Only used when the company has the
 * add-on.
 */
export function useRoadAlerts(enabled: boolean, tenantId: string, position: LngLat | null) {
  const supabase = getBrowserClient();
  const [alerts, setAlerts] = useState<RoadAlert[]>([]);
  const positionRef = useRef(position);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  const load = useCallback(async () => {
    const p = positionRef.current;
    if (!enabled || !p) return;
    const { data, error } = await supabase.rpc("road_alerts_near", { p_lon: p[0], p_lat: p[1], p_radius_m: 30000, p_tenant_id: tenantId });
    if (!error) setAlerts((data ?? []) as RoadAlert[]);
  }, [enabled, supabase, tenantId]);

  const located = Boolean(position);
  useEffect(() => {
    if (!enabled || !located) return;
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [enabled, located, load]);

  const report = useCallback(async (kind: RoadAlertKind, at: LngLat) => {
    const { data, error } = await supabase.rpc("report_road_alert", { p_kind: kind, p_lon: at[0], p_lat: at[1], p_tenant_id: tenantId });
    await load();
    return error ? { error: error.message } : { alert: data as RoadAlert };
  }, [supabase, tenantId, load]);

  const vote = useCallback(async (id: string, stillThere: boolean) => {
    const { error } = await supabase.rpc("vote_road_alert", { p_alert_id: id, p_still_there: stillThere, p_tenant_id: tenantId });
    await load();
    return error ? { error: error.message } : {};
  }, [supabase, tenantId, load]);

  return { alerts, report, vote };
}

/** The nearest alert within warning distance that someone else reported. */
export function nearestAhead(alerts: RoadAlert[], position: LngLat | null) {
  if (!position) return null;
  let best: { alert: RoadAlert; distanceM: number } | null = null;
  for (const a of alerts) {
    if (a.mine) continue;
    const d = haversine(position, [a.lon, a.lat]);
    if (d <= WARN_M && (!best || d < best.distanceM)) best = { alert: a, distanceM: d };
  }
  return best;
}

function KindIcon({ kind }: { kind: RoadAlertKind }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "hazard" && <><path d="M12 4 21 20H3z" /><path d="M12 10v5" /><circle cx="12" cy="17.6" r="0.6" /></>}
      {kind === "police" && <><path d="M12 3 5 6v5c0 4.6 3 8.3 7 10 4-1.7 7-5.4 7-10V6z" /><path d="m9 12 2.2 2.2L15 10.4" /></>}
      {kind === "speed_camera" && <><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M8.5 7 10 4.5h4L15.5 7" /><circle cx="12" cy="13.5" r="3.2" /></>}
    </svg>
  );
}

const TONE: Record<RoadAlertKind, string> = {
  hazard: "bg-[#FEF0C7] text-[#93370D]",
  police: "bg-[#DBEAFE] text-[#1E40AF]",
  speed_camera: "bg-[#EEF1F5] text-[#344054]",
};

/** The warning shown as the driver comes up to an alert, with "Still there" and "Not there". */
export function AlertBanner({ alert, distanceM, timeZone, busy, onVote, onClose }: {
  alert: RoadAlert; distanceM: number | null; timeZone: string; busy: boolean;
  onVote: (stillThere: boolean) => void; onClose?: () => void;
}) {
  return (
    <section className={`rounded-[var(--radius-card)] p-3 ${TONE[alert.kind]}`} aria-live="polite">
      <div className="flex items-center gap-3">
        <KindIcon kind={alert.kind} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {ROAD_ALERT_LABEL[alert.kind]}{distanceM != null ? `, ${formatDistance(Math.max(10, Math.round(distanceM / 10) * 10))} away` : ""}
          </div>
          <div className="text-sm">
            {alert.mine ? "You reported this" : "Reported"} at {formatTime(alert.reported_at, timeZone)}
            {alert.confirmations > 0 ? `, confirmed by ${alert.confirmations} ${alert.confirmations === 1 ? "driver" : "drivers"}` : ""}
          </div>
        </div>
        {onClose && <button className="btn-secondary btn-sm shrink-0" onClick={onClose}>Close</button>}
      </div>
      {alert.mine ? (
        <button className="btn-secondary mt-3 w-full" disabled={busy} onClick={() => onVote(false)}>Remove my report</button>
      ) : alert.voted ? (
        <p className="mt-2 text-sm">Your answer is saved.</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button className="btn-secondary" disabled={busy} onClick={() => onVote(true)}>Still there</button>
          <button className="btn-secondary" disabled={busy} onClick={() => onVote(false)}>Not there</button>
        </div>
      )}
    </section>
  );
}

/** The three report buttons. Two taps: "Report on the road", then what it is. */
export function ReportPanel({ canReport, busy, onReport, onCancel }: {
  canReport: boolean; busy: boolean; onReport: (kind: RoadAlertKind) => void; onCancel: () => void;
}) {
  return (
    <section className="card p-3">
      <h2 className="font-semibold">What is on the road here?</h2>
      <p className="mt-1 text-sm text-muted">
        {canReport ? "It is pinned where you are now, and other drivers are warned as they come near." : "Waiting for a good GPS position before you can report."}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {ROAD_ALERT_KINDS.map((kind) => (
          <button
            key={kind}
            className={`flex min-h-24 flex-col items-center justify-center gap-2 rounded-[var(--radius-control)] px-2 text-center text-sm font-medium disabled:opacity-50 ${TONE[kind]}`}
            disabled={!canReport || busy}
            onClick={() => onReport(kind)}
          >
            <KindIcon kind={kind} />
            {ROAD_ALERT_LABEL[kind]}
          </button>
        ))}
      </div>
      <button className="btn-secondary mt-3 w-full" onClick={onCancel}>Cancel</button>
    </section>
  );
}

/** A round speed limit sign, as on the road. */
export function LimitSign({ kmh, over }: { kmh: number; over: boolean }) {
  return (
    <span
      role="img"
      aria-label={`Speed limit ${kmh} kilometres an hour`}
      title={`Speed limit ${kmh} km/h`}
      className={`flex h-11 w-11 items-center justify-center rounded-full border-4 border-[#B42318] bg-white text-[0.9375rem] font-semibold tabular-nums shadow-sm ${over ? "text-[#B42318]" : "text-ink"}`}
    >
      {kmh}
    </span>
  );
}
