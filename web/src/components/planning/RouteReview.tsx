"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import { IconArrowDown, IconArrowUp, IconGrip } from "@/components/icons";
import { Card, Field, Notice } from "@/components/ui";
import { formatDistance, formatDuration, formatLitres, formatMoney, formatTime } from "@/lib/format";
import type { LngLat } from "@/lib/geo";
import { OBJECTIVE_LABEL, type Objective } from "@/lib/routing/types";
import { saveRoute } from "@/app/(app)/routes/actions";

export type StopMetaClient = {
  key: string;
  orderId: string | null;
  locationId: string;
  name: string;
  reference: string | null;
  customer: string | null;
  cartons: number;
  position: LngLat;
};

export type OptionClient = {
  objective: Objective;
  order: string[];
  distanceM: number;
  durationS: number;
  etas: string[];
  returnAt: string;
  geometry: LngLat[];
  source: "routing_server" | "road_graph" | "estimate";
  fuel: { litres: number; cost: number | null; formula: string; currency: string } | null;
};

type Person = { id: string; name: string };
type Vehicle = { id: string; plate: string; model: string | null };

export function RouteReview({
  routeId,
  depot,
  stops: initialStops,
  options,
  initialObjective,
  drivers,
  vehicles,
  defaults,
  timeZone,
  step,
  onStepChange,
}: {
  routeId?: string | null;
  depot: { id: string; name: string; position: LngLat };
  stops: StopMetaClient[];
  options: OptionClient[];
  initialObjective: Objective;
  drivers: Person[];
  vehicles: Vehicle[];
  defaults: { name: string; routeDate: string; departureAt: string; driverId: string | null; vehicleId: string | null };
  timeZone: string;
  /** In the plan flow, "review" shows the options and stops; "assign" shows assignment. Elsewhere both show. */
  step?: "review" | "assign";
  onStepChange?: (step: "review" | "assign") => void;
}) {
  const router = useRouter();
  const [objective, setObjective] = useState<Objective>(initialObjective);
  const [custom, setCustom] = useState<OptionClient | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [form, setForm] = useState(defaults);

  const meta = useMemo(() => new Map(initialStops.map((s) => [s.key, s])), [initialStops]);
  const current = custom ?? options.find((o) => o.objective === objective) ?? options[0];
  const isEstimate = current?.source === "estimate";
  const identical = options.length > 1 && options.every((o) => o.order.join() === options[0].order.join());

  async function recalc(order: string[]) {
    setBusy("recalc");
    setError(null);
    const res = await fetch("/api/routes/sequence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: order, depotId: depot.id, vehicleId: form.vehicleId, departureAt: form.departureAt, objective }),
    });
    setBusy(null);
    const json = await res.json();
    if (!res.ok) return setError(json.error ?? "Could not recalculate the route");
    setCustom(json.option);
  }

  function move(key: string, to: number) {
    const order = [...current.order];
    const from = order.indexOf(key);
    if (from < 0 || to < 0 || to >= order.length || from === to) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    void recalc(order);
  }

  async function save(send: boolean) {
    setBusy(send ? "send" : "save");
    setError(null);
    const result = await saveRoute({
      id: routeId ?? null,
      name: form.name || null,
      routeDate: form.routeDate,
      depotId: depot.id,
      optimiseFor: objective,
      departureAt: form.departureAt,
      driverId: form.driverId || null,
      vehicleId: form.vehicleId || null,
      distanceM: current.distanceM,
      durationS: current.durationS,
      fuelLitres: current.fuel?.litres ?? null,
      geometry: current.geometry,
      stops: current.order.map((k, i) => ({ locationId: meta.get(k)!.locationId, orderId: meta.get(k)!.orderId, eta: current.etas[i] })),
      send,
    });
    setBusy(null);
    if (result.error && !result.id) return setError(result.error);
    if (result.error) setError(result.error);
    router.push(`/routes/${result.id}?saved=${send ? "sent" : "draft"}`);
    router.refresh();
  }

  if (!current) return <Notice tone="amber">No route options yet.</Notice>;

  const markers: MapMarker[] = [
    { id: "depot", position: depot.position, kind: "depot", text: "D", label: `Depot: ${depot.name}` },
    ...current.order.map((k, i) => ({ id: k, position: meta.get(k)!.position, kind: "stop" as const, text: String(i + 1), label: `${i + 1}. ${meta.get(k)!.name}` })),
  ];
  const showReview = !step || step === "review";
  const showAssign = !step || step === "assign";

  return (
    <div className="space-y-5">
      {isEstimate && (
        <Notice tone="amber">
          Estimated with straight-line distances because the routing server is not connected. Times and distances are approximate; connect the routing server for road routes.
        </Notice>
      )}
      {error && <Notice tone="red">{error}</Notice>}

      {showReview && (
        <section aria-label="Route options" className="grid gap-3 md:grid-cols-3">
          {options.map((o) => {
            const selected = !custom && o.objective === objective;
            return (
              <button
                key={o.objective}
                type="button"
                onClick={() => { setObjective(o.objective); setCustom(null); }}
                aria-pressed={selected}
                className={`card p-4 text-left transition-colors ${selected ? "border-2 border-accent" : "hover:border-[#c9d2de]"}`}
              >
                <p className="text-sm font-semibold">{OBJECTIVE_LABEL[o.objective]}</p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-xs text-muted">Time</dt><dd className="font-semibold">{formatDuration(o.durationS)}</dd></div>
                  <div><dt className="text-xs text-muted">Distance</dt><dd className="font-semibold">{formatDistance(o.distanceM)}</dd></div>
                  <div><dt className="text-xs text-muted">Fuel</dt><dd className="font-semibold">{o.fuel ? formatLitres(o.fuel.litres) : "Pick a vehicle"}</dd></div>
                </dl>
                {o.fuel?.cost != null && <p className="mt-1 text-xs text-muted">About {formatMoney(o.fuel.cost, o.fuel.currency)} of fuel</p>}
                <p className="mt-2 text-xs text-muted">Back at depot {formatTime(o.returnAt, timeZone)}</p>
              </button>
            );
          })}
        </section>
      )}
      {showReview && identical && (
        <p className="text-sm text-muted">All three options visit the stops in the same order for these invoices.</p>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <Card title="Map" bodyClassName="p-0">
          <MapView markers={markers} lines={[{ id: "route", coordinates: current.geometry }]} height={480} fitKey={current.order.join()} ariaLabel="Route map" />
        </Card>

        {showReview ? (
          <Card
            title={custom ? "Stops (your order)" : "Stops"}
            actions={custom && <button type="button" className="btn-secondary btn-sm" onClick={() => setCustom(null)}>Use suggested order</button>}
            bodyClassName="p-0"
          >
            <ol className="divide-y divide-line">
              <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="flex size-7 items-center justify-center rounded-md bg-navy text-xs font-semibold text-white">D</span>
                <span className="flex-1 font-medium">Leave {depot.name}</span>
                <span className="text-muted">{formatTime(form.departureAt, timeZone)}</span>
              </li>
              {current.order.map((k, i) => {
                const s = meta.get(k)!;
                return (
                  <li
                    key={k}
                    draggable
                    onDragStart={() => setDragKey(k)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (dragKey) move(dragKey, i); setDragKey(null); }}
                    className={`flex items-center gap-3 px-4 py-2.5 ${dragKey === k ? "opacity-50" : ""}`}
                  >
                    <IconGrip className="shrink-0 cursor-grab text-muted" />
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{s.name}</p>
                      <p className="truncate text-xs text-muted">{[s.reference, s.cartons ? `${s.cartons} cartons` : null].filter(Boolean).join(", ")}</p>
                    </div>
                    <span className="text-sm">{formatTime(current.etas[i], timeZone)}</span>
                    <div className="flex">
                      <button type="button" className="btn-secondary btn-sm px-2" aria-label={`Move ${s.name} up`} disabled={i === 0 || !!busy} onClick={() => move(k, i - 1)}><IconArrowUp width={14} /></button>
                      <button type="button" className="btn-secondary btn-sm ml-1 px-2" aria-label={`Move ${s.name} down`} disabled={i === current.order.length - 1 || !!busy} onClick={() => move(k, i + 1)}><IconArrowDown width={14} /></button>
                    </div>
                  </li>
                );
              })}
              <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="flex size-7 items-center justify-center rounded-md bg-navy text-xs font-semibold text-white">D</span>
                <span className="flex-1 font-medium">Back at {depot.name}</span>
                <span className="text-muted">{formatTime(current.returnAt, timeZone)}</span>
              </li>
            </ol>
            <div className="border-t border-line px-4 py-3 text-sm">
              <p><span className="text-muted">Total:</span> {formatDuration(current.durationS)}, {formatDistance(current.distanceM)}{current.fuel ? `, ${formatLitres(current.fuel.litres)}` : ""}</p>
              {current.fuel && <p className="mt-1 text-xs text-muted">Fuel: {current.fuel.formula}.</p>}
              {busy === "recalc" && <p className="mt-1 text-xs text-muted" role="status">Recalculating times</p>}
              <p className="mt-1 text-xs text-muted">Drag stops, or use Move up and Move down, to change the order. Times update automatically.</p>
            </div>
            {step === "review" && (
              <div className="flex justify-end border-t border-line px-4 py-3">
                <button type="button" className="btn-primary" onClick={() => onStepChange?.("assign")}>Next: assign and send</button>
              </div>
            )}
          </Card>
        ) : null}

        {showAssign && (
          <Card title="Assign and send" className={step === "assign" ? "" : "xl:col-start-2"}>
            <div className="space-y-4">
              <Field label="Route name" htmlFor="name">
                <input id="name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date" htmlFor="routeDate">
                  <input id="routeDate" type="date" className="input" value={form.routeDate} onChange={(e) => setForm({ ...form, routeDate: e.target.value })} />
                </Field>
                <Field label="Leave depot" htmlFor="departure" hint="Fiji time">
                  <input id="departure" className="input" value={formatTime(form.departureAt, timeZone)} readOnly />
                </Field>
              </div>
              <Field label="Driver" htmlFor="driver">
                <select id="driver" className="input" value={form.driverId ?? ""} onChange={(e) => setForm({ ...form, driverId: e.target.value || null })}>
                  <option value="">Choose a driver</option>
                  {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </Field>
              <Field label="Vehicle" htmlFor="vehicle" hint="The vehicle's fuel use is used for the estimate.">
                <select id="vehicle" className="input" value={form.vehicleId ?? ""} onChange={(e) => setForm({ ...form, vehicleId: e.target.value || null })}>
                  <option value="">Choose a vehicle</option>
                  {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate}{v.model ? `, ${v.model}` : ""}</option>)}
                </select>
              </Field>
              <dl className="grid grid-cols-3 gap-2 rounded-[var(--radius-control)] bg-page p-3 text-sm">
                <div><dt className="text-xs text-muted">Stops</dt><dd className="font-semibold">{current.order.length}</dd></div>
                <div><dt className="text-xs text-muted">Time</dt><dd className="font-semibold">{formatDuration(current.durationS)}</dd></div>
                <div><dt className="text-xs text-muted">Distance</dt><dd className="font-semibold">{formatDistance(current.distanceM)}</dd></div>
              </dl>
              <div className="flex flex-wrap justify-end gap-2">
                {step === "assign" && <button type="button" className="btn-secondary mr-auto" onClick={() => onStepChange?.("review")}>Back to review</button>}
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => save(false)}>{busy === "save" ? "Saving" : "Save draft"}</button>
                <button type="button" className="btn-primary" disabled={!!busy || !form.driverId || !form.vehicleId} onClick={() => save(true)}>{busy === "send" ? "Sending" : "Send to driver"}</button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
