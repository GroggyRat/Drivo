"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import { Badge, Card, EmptyState, StatCard, TableWrap } from "@/components/ui";
import { formatDistance, formatDuration, formatSpeed, formatTime } from "@/lib/format";
import type { LiveSnapshot, VehicleStatus } from "@/lib/live";
import { getBrowserClient } from "@/lib/supabase/client";
import { acknowledgeAlert } from "./actions";

const STATUS: Record<VehicleStatus, { label: string; tone: "green" | "red" | "amber" | "grey" }> = {
  moving: { label: "Moving", tone: "green" },
  stopped: { label: "Stopped", tone: "grey" },
  over_limit: { label: "Over limit", tone: "red" },
  no_signal: { label: "No signal", tone: "amber" },
  not_started: { label: "Not started", tone: "grey" },
  finished: { label: "Route done", tone: "grey" },
};

type LivePosition = { driver_id: string; lon: number; lat: number; speed_kmh: number; heading: number | null; at: string };

export function LiveOps({ initial, tenantId, timeZone }: { initial: LiveSnapshot; tenantId: string; timeZone: string }) {
  const [snap, setSnap] = useState(initial);
  const [live, setLive] = useState<Record<string, LivePosition>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    const res = await fetch("/api/live", { cache: "no-store" });
    if (res.ok) setSnap(await res.json());
  }, []);

  // Database snapshot every 5 seconds, plus live positions broadcast by the
  // driver app between uploads (Realtime Broadcast, one channel per tenant).
  useEffect(() => {
    const timer = setInterval(refresh, 5000);
    const channel = getBrowserClient()
      .channel(`tenant:${tenantId}`)
      .on("broadcast", { event: "position" }, ({ payload }) => {
        const p = payload as LivePosition;
        setLive((prev) => ({ ...prev, [p.driver_id]: p }));
      })
      .on("broadcast", { event: "speed_event" }, () => refresh())
      .subscribe();
    return () => {
      clearInterval(timer);
      getBrowserClient().removeChannel(channel);
    };
  }, [refresh, tenantId]);

  const vehicles = useMemo(
    () =>
      snap.vehicles.map((v) => {
        const l = live[v.driverId];
        if (l && (!v.recordedAt || l.at > v.recordedAt)) {
          return { ...v, position: [l.lon, l.lat] as [number, number], speedKmh: l.speed_kmh, heading: l.heading, recordedAt: l.at };
        }
        return v;
      }),
    [snap, live],
  );

  const markers: MapMarker[] = vehicles
    .filter((v) => v.position)
    .map((v) => ({
      id: v.driverId,
      position: v.position!,
      kind: selected === v.driverId ? "selected" : "vehicle",
      heading: v.heading,
      label: `${v.driverName}${v.plate ? `, ${v.plate}` : ""}, ${formatSpeed(v.speedKmh)}`,
      onClick: () => setSelected(v.driverId),
    }));
  const openAlerts = snap.alerts.filter((a) => !a.acknowledged);
  for (const a of openAlerts.slice(0, 10)) {
    markers.push({ id: `alert-${a.id}`, position: a.position, kind: "hazard", label: `Over limit: ${a.driverName}, ${a.maxSpeedKmh} km/h in a ${a.limitKmh} zone` });
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Vehicles on the road" value={snap.summary.onTheRoad} detail={`${vehicles.length} drivers with routes today`} />
        <StatCard label="Deliveries completed" value={`${snap.summary.delivered} of ${snap.summary.plannedStops}`} detail="Delivered or part delivered" />
        <StatCard label="Planned distance" value={formatDistance(snap.summary.distanceM)} detail="Today's sent routes" />
        <StatCard label="Speed alerts" value={snap.summary.openAlerts} detail="Not yet acknowledged" tone={snap.summary.openAlerts ? "red" : undefined} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_360px] [&>*]:min-w-0">
        <Card title="Live map" bodyClassName="p-0" actions={<span className="text-xs text-muted">Updated {formatTime(snap.generatedAt, timeZone)}</span>}>
          <MapView
            markers={markers}
            lines={snap.routeLines.map((r) => ({ id: r.routeId, coordinates: r.coordinates, color: "#2563eb", width: 3, opacity: 0.55 }))}
            height={460}
            fitKey={`${vehicles.filter((v) => v.position).length}`}
            ariaLabel="Live map of vehicles"
          />
        </Card>

        <Card title="Speed alerts" bodyClassName="p-0">
          {snap.alerts.length === 0 ? (
            <EmptyState title="No speed alerts in the last 24 hours" />
          ) : (
            <ul className="max-h-[460px] divide-y divide-line overflow-y-auto">
              {snap.alerts.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="font-medium">{a.driverName}{a.plate && <span className="text-muted">, {a.plate}</span>}</p>
                    <p className="text-sm">
                      <span className="font-semibold text-bad">{a.maxSpeedKmh} km/h</span> in a {a.limitKmh} km/h zone
                      {a.zoneName ? ` (${a.zoneName})` : ""}
                    </p>
                    <p className="text-xs text-muted">{formatTime(a.startedAt, timeZone)}, for {a.durationS < 60 ? `${a.durationS} seconds` : formatDuration(a.durationS)}</p>
                  </div>
                  {a.acknowledged ? (
                    <Badge tone="grey">Acknowledged</Badge>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={pending}
                      onClick={() => startTransition(async () => { await acknowledgeAlert(a.id); await refresh(); })}
                    >
                      Acknowledge
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Vehicles" bodyClassName="p-0">
        {vehicles.length === 0 ? (
          <EmptyState title="No routes sent for today">Plan a route and send it to a driver to see them here.</EmptyState>
        ) : (
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Driver</th>
                  <th scope="col">Vehicle</th>
                  <th scope="col">Route</th>
                  <th scope="col">Speed</th>
                  <th scope="col">Status</th>
                  <th scope="col">Stops</th>
                  <th scope="col">Next stop</th>
                  <th scope="col">Last update</th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.driverId} className={selected === v.driverId ? "bg-info-bg/40" : undefined}>
                    <td>
                      <button type="button" className="link text-left" onClick={() => setSelected(v.driverId)}>{v.driverName}</button>
                    </td>
                    <td>{v.plate ?? <span className="text-muted">None</span>}</td>
                    <td>{v.routeName ?? <span className="text-muted">None</span>}</td>
                    <td className={v.status === "over_limit" ? "font-semibold text-bad" : ""}>{v.speedKmh != null ? formatSpeed(v.speedKmh) : ""}</td>
                    <td><Badge tone={STATUS[v.status].tone} icon>{STATUS[v.status].label}</Badge></td>
                    <td>{v.stopsDone} of {v.stopsTotal}</td>
                    <td>{v.nextStop ?? <span className="text-muted">None</span>}</td>
                    <td className="text-muted">{v.recordedAt ? formatTime(v.recordedAt, timeZone) : "No position yet"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
