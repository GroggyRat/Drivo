"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { RouteReview, type OptionClient, type StopMetaClient } from "@/components/planning/RouteReview";
import { Badge, Card, EmptyState, Field, Notice, TableWrap } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { OBJECTIVE_LABEL, OBJECTIVES, type Objective } from "@/lib/routing/types";

export type PlanOrder = {
  id: string;
  reference: string;
  source: string;
  customer: string;
  cartons: number;
  total: string | null;
  currency: string;
  status: string;
  confirmedAt: string | null;
  located: boolean;
  locationName: string | null;
};

type Step = "select" | "review" | "assign";
const STEPS: { key: Step; label: string }[] = [
  { key: "select", label: "Select invoices" },
  { key: "review", label: "Review route" },
  { key: "assign", label: "Assign and send" },
];

/** ISO time for a local date and HH:MM in a time zone. */
function zonedIso(date: string, time: string, timeZone: string) {
  const guess = new Date(`${date}T${time}:00Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime())).toISOString();
}

export function PlanFlow({ orders, depots, vehicles, drivers, today, tomorrow, timeZone }: {
  orders: PlanOrder[];
  depots: { id: string; name: string; position: [number, number] }[];
  vehicles: { id: string; plate: string; model: string | null; fuel: number; capacity: number | null }[];
  drivers: { id: string; name: string }[];
  today: string;
  tomorrow: string;
  timeZone: string;
}) {
  const [step, setStep] = useState<Step>("select");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [settings, setSettings] = useState({
    date: tomorrow,
    time: "08:00",
    depotId: depots[0]?.id ?? "",
    vehicleId: vehicles[0]?.id ?? "",
    objective: "lowest_fuel" as Objective,
  });
  const [plan, setPlan] = useState<{ depot: { id: string; name: string; position: [number, number] }; stops: StopMetaClient[]; options: OptionClient[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return orders.filter((o) => !q || o.customer.toLowerCase().includes(q) || o.reference.toLowerCase().includes(q));
  }, [orders, filter]);
  const chosen = orders.filter((o) => selected.has(o.id));
  const cartons = chosen.reduce((s, o) => s + o.cartons, 0);
  const vehicle = vehicles.find((v) => v.id === settings.vehicleId);
  const overCapacity = vehicle?.capacity != null && cartons > vehicle.capacity;
  const needsPin = orders.filter((o) => !o.located).length;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function review() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/routes/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderIds: [...selected],
        depotId: settings.depotId,
        vehicleId: settings.vehicleId || null,
        departureAt: zonedIso(settings.date, settings.time, timeZone),
      }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setError(json.error ?? "Could not plan the route");
    setPlan(json);
    setStep("review");
  }

  return (
    <div className="space-y-5">
      <ol className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => {
          const index = STEPS.findIndex((x) => x.key === step);
          const state = i < index ? "done" : i === index ? "current" : "todo";
          return (
            <li key={s.key} aria-current={state === "current" ? "step" : undefined}
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${state === "current" ? "border-accent bg-info-bg font-medium text-info" : state === "done" ? "border-line bg-white text-ink" : "border-line bg-white text-muted"}`}>
              <span className="font-semibold">{i + 1}</span> {s.label}
            </li>
          );
        })}
      </ol>
      {error && <Notice tone="red">{error}</Notice>}

      {step === "select" && (
        <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
          <Card
            title="Invoices ready for delivery"
            actions={<input aria-label="Search invoices" placeholder="Search customer or invoice" className="input min-h-9 w-56" value={filter} onChange={(e) => setFilter(e.target.value)} />}
            bodyClassName="p-0"
          >
            {needsPin > 0 && (
              <div className="border-b border-line px-4 py-2.5 text-sm">
                <Badge tone="amber" icon>Needs a pin</Badge> {needsPin} invoice{needsPin === 1 ? "" : "s"} cannot be added until the customer has an approved location.{" "}
                <Link href="/locations" className="link">Review pins</Link>
              </div>
            )}
            {visible.length === 0 ? (
              <EmptyState title="No invoices ready for delivery">Confirmed invoices from BillZilla, and orders added in Drivo, appear here.</EmptyState>
            ) : (
              <TableWrap>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col" className="w-10">
                        <input
                          type="checkbox"
                          aria-label="Select all invoices with a location"
                          className="size-4"
                          checked={visible.filter((o) => o.located).every((o) => selected.has(o.id)) && visible.some((o) => o.located)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            visible.filter((o) => o.located).forEach((o) => (e.target.checked ? next.add(o.id) : next.delete(o.id)));
                            setSelected(next);
                          }}
                        />
                      </th>
                      <th scope="col">Invoice</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Cartons</th>
                      <th scope="col">Value</th>
                      <th scope="col">Confirmed</th>
                      <th scope="col">Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((o) => (
                      <tr key={o.id} className={selected.has(o.id) ? "bg-info-bg/40" : undefined}>
                        <td>
                          <input type="checkbox" className="size-4" aria-label={`Select ${o.reference}, ${o.customer}`} disabled={!o.located} checked={selected.has(o.id)} onChange={() => toggle(o.id)} />
                        </td>
                        <td className="font-medium">{o.reference}{o.status === "failed" && <span className="ml-2"><Badge tone="red">Retry</Badge></span>}</td>
                        <td>{o.customer}</td>
                        <td>{o.cartons}</td>
                        <td>{formatMoney(o.total, o.currency)}</td>
                        <td>{formatDate(o.confirmedAt, timeZone)}</td>
                        <td>{o.located ? <Badge tone="green" icon>Located</Badge> : <Badge tone="amber" icon>Needs a pin</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card title="Route settings">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date" htmlFor="date">
                  <input id="date" type="date" className="input" min={today} value={settings.date} onChange={(e) => setSettings({ ...settings, date: e.target.value })} />
                </Field>
                <Field label="Leave depot at" htmlFor="time">
                  <input id="time" type="time" className="input" value={settings.time} onChange={(e) => setSettings({ ...settings, time: e.target.value })} />
                </Field>
              </div>
              <Field label="Depot" htmlFor="depot">
                <select id="depot" className="input" value={settings.depotId} onChange={(e) => setSettings({ ...settings, depotId: e.target.value })}>
                  {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </Field>
              <Field label="Vehicle" htmlFor="veh" hint={vehicle ? `${vehicle.fuel} L/100 km${vehicle.capacity ? `, up to ${vehicle.capacity} cartons` : ""}` : undefined}>
                <select id="veh" className="input" value={settings.vehicleId} onChange={(e) => setSettings({ ...settings, vehicleId: e.target.value })}>
                  <option value="">Decide later</option>
                  {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate}{v.model ? `, ${v.model}` : ""}</option>)}
                </select>
              </Field>
              <fieldset>
                <legend className="field-label">Optimise for</legend>
                <div className="space-y-1.5">
                  {OBJECTIVES.map((o) => (
                    <label key={o} className="flex items-center gap-2 text-sm">
                      <input type="radio" name="objective" className="size-4" checked={settings.objective === o} onChange={() => setSettings({ ...settings, objective: o })} />
                      {OBJECTIVE_LABEL[o]}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">All three options are shown for comparison; this one is selected first.</p>
              </fieldset>
              <div className="rounded-[var(--radius-control)] bg-page p-3 text-sm">
                <p><span className="font-semibold">{chosen.length}</span> invoices, <span className="font-semibold">{cartons}</span> cartons</p>
                {overCapacity && <p className="mt-1 text-bad">More than this vehicle carries ({vehicle?.capacity} cartons).</p>}
              </div>
              <button type="button" className="btn-primary w-full" disabled={!chosen.length || !settings.depotId || busy} onClick={review}>
                {busy ? "Planning" : "Next: review route"}
              </button>
            </div>
          </Card>
        </div>
      )}

      {step !== "select" && plan && (
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setStep("select")}>Change invoices</button>
          <RouteReview
            depot={plan.depot}
            stops={plan.stops}
            options={plan.options}
            initialObjective={settings.objective}
            drivers={drivers}
            vehicles={vehicles}
            timeZone={timeZone}
            step={step}
            onStepChange={setStep}
            defaults={{
              name: `${depots.find((d) => d.id === settings.depotId)?.name ?? "Route"} run, ${formatDate(settings.date)}`,
              routeDate: settings.date,
              departureAt: zonedIso(settings.date, settings.time, timeZone),
              driverId: null,
              vehicleId: settings.vehicleId || null,
            }}
          />
        </>
      )}
    </div>
  );
}
