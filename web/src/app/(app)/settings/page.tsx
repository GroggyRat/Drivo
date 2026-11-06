import type { Metadata } from "next";
import { ConfirmSubmit, SubmitButton } from "@/components/buttons";
import { Badge, Card, Field, Notice, PageHeader, TableWrap, Tabs } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { fuelFormula } from "@/lib/fuel";
import { requireManager } from "@/lib/tenant";
import { LocationPicker } from "../locations/LocationPicker";
import { addDepot, addPerson, saveFuelSettings, saveSpeedSettings, saveVehicle, setDepotActive, setPersonActive, setVehicleActive, updatePerson } from "./actions";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const ROLE = { owner: "Owner", admin: "Admin", dispatcher: "Dispatcher", driver: "Driver" } as const;
type SP = Promise<{ tab?: string; notice?: string; error?: string; email?: string; password?: string }>;

export default async function SettingsPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireManager();
  const sp = await searchParams;
  const tab = sp.tab ?? "people";
  const t = ctx.tenant.id;
  const [{ data: people }, { data: vehicles }, { data: depots }, { data: settings }, { data: zones }, { data: outbox }] = await Promise.all([
    ctx.supabase.from("memberships").select("user_id, full_name, email, phone, role, active, kaiworkforce_employee_id").eq("tenant_id", t).order("full_name"),
    ctx.supabase.from("vehicles").select("*").eq("tenant_id", t).order("plate"),
    ctx.supabase.from("depots").select("id, name, address, lon, lat, active").eq("tenant_id", t).order("name"),
    ctx.supabase.from("tenant_settings").select("*").eq("tenant_id", t).single(),
    ctx.supabase.from("speed_zones").select("id, name, limit_kmh, active").eq("tenant_id", t).order("name"),
    ctx.supabase.from("integration_outbox").select("id, target_id, status, attempts, last_error, created_at").eq("tenant_id", t).neq("status", "sent").order("created_at", { ascending: false }).limit(20),
  ]);
  const readOnly = !ctx.isAdmin;
  const s = settings!;

  return (
    <>
      <PageHeader title="Settings" description={readOnly ? "Only Owners and Admins can change settings." : `Settings for ${ctx.tenant.name}`} />
      {sp.notice === "added" && sp.password && (
        <div className="mb-4">
          <Notice tone="green">
            Account created for {sp.email}. Temporary password: <strong className="select-all">{sp.password}</strong>. Give it to them in person; they can sign in to the Drivo app with it now. It is not shown again.
          </Notice>
        </div>
      )}
      {sp.notice && !sp.password && <div className="mb-4"><Notice tone="green">{sp.notice === "added-existing" ? "Added. They already have a KaiTech account, so they sign in with their existing password." : sp.notice === "deactivated" ? "Access removed. Their history is kept." : "Saved."}</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="red">{sp.error}</Notice></div>}
      <Tabs
        current={tab}
        tabs={[
          { key: "people", label: "Users and roles", href: "/settings" },
          { key: "vehicles", label: "Vehicles and fuel profiles", href: "/settings?tab=vehicles" },
          { key: "depots", label: "Depots", href: "/settings?tab=depots" },
          { key: "speed", label: "Speed limits", href: "/settings?tab=speed" },
          { key: "fuel", label: "Fuel price", href: "/settings?tab=fuel" },
          { key: "integrations", label: "Integrations", href: "/settings?tab=integrations" },
        ]}
      />

      {tab === "people" && (
        <div className="grid gap-5 xl:grid-cols-[1fr_360px] [&>*]:min-w-0">
          <Card bodyClassName="p-0">
            <TableWrap>
              <table className="data-table">
                <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">KaiWorkforce id</th><th scope="col">Access</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {(people ?? []).map((p) => {
                    const self = p.user_id === ctx.userId;
                    const editable = !readOnly && !self && (p.role !== "owner" || ctx.role === "owner");
                    return (
                      <tr key={p.user_id} className={p.active ? undefined : "text-muted"}>
                        <td><p className="font-medium">{p.full_name}{self && " (you)"}</p><p className="text-xs text-muted">{p.email}</p></td>
                        <td colSpan={editable ? 2 : 1}>
                          {editable ? (
                            <form action={updatePerson} className="flex flex-wrap gap-2">
                              <input type="hidden" name="user_id" value={p.user_id} />
                              <label className="sr-only" htmlFor={`role-${p.user_id}`}>Role for {p.full_name}</label>
                              <select id={`role-${p.user_id}`} name="role" defaultValue={p.role} className="input min-h-9 w-36">
                                {ctx.role === "owner" && <option value="owner">Owner</option>}
                                <option value="admin">Admin</option><option value="dispatcher">Dispatcher</option><option value="driver">Driver</option>
                              </select>
                              <label className="sr-only" htmlFor={`kw-${p.user_id}`}>KaiWorkforce employee id for {p.full_name}</label>
                              <input id={`kw-${p.user_id}`} name="kaiworkforce_employee_id" defaultValue={p.kaiworkforce_employee_id ?? ""} placeholder="Employee id" className="input min-h-9 w-32" />
                              <button className="btn-secondary btn-sm" type="submit">Save</button>
                            </form>
                          ) : ROLE[p.role as keyof typeof ROLE]}
                        </td>
                        {!editable && <td>{p.kaiworkforce_employee_id ?? <span className="text-muted">None</span>}</td>}
                        <td>{p.active ? <Badge tone="green" icon>Active</Badge> : <Badge tone="grey">Removed</Badge>}</td>
                        <td className="text-right">
                          {editable && (
                            <form action={setPersonActive}>
                              <input type="hidden" name="user_id" value={p.user_id} />
                              <input type="hidden" name="active" value={p.active ? "false" : "true"} />
                              {p.active ? (
                                <ConfirmSubmit label="Remove access" title={`Remove ${p.full_name}?`} message="They can no longer sign in to this company. Their routes and deliveries stay in the record, and you can give access back later." confirmLabel="Remove access" />
                              ) : (
                                <button className="btn-secondary btn-sm" type="submit">Give access back</button>
                              )}
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          {!readOnly && (
            <Card title="Add a person">
              <form action={addPerson} className="space-y-3">
                <Field label="Full name" htmlFor="full_name"><input id="full_name" name="full_name" className="input" required /></Field>
                <Field label="Email" htmlFor="email" hint="They sign in with this email. If they already use BillZilla or KaiWorkforce, use the same email."><input id="email" name="email" type="email" className="input" required /></Field>
                <Field label="Phone" htmlFor="phone"><input id="phone" name="phone" className="input" inputMode="tel" /></Field>
                <Field label="Role" htmlFor="role">
                  <select id="role" name="role" className="input" defaultValue="driver"><option value="driver">Driver</option><option value="dispatcher">Dispatcher</option><option value="admin">Admin</option></select>
                </Field>
                <Field label="KaiWorkforce employee id" htmlFor="kwid" hint="For drivers: clock-in in KaiWorkforce starts tracking."><input id="kwid" name="kaiworkforce_employee_id" className="input" /></Field>
                <SubmitButton pendingLabel="Adding">Add person</SubmitButton>
              </form>
            </Card>
          )}
        </div>
      )}

      {tab === "vehicles" && (
        <div className="grid gap-5 xl:grid-cols-[1fr_360px] [&>*]:min-w-0">
          <Card bodyClassName="p-0">
            <TableWrap>
              <table className="data-table">
                <thead><tr><th scope="col">Plate</th><th scope="col">Model</th><th scope="col">Fuel</th><th scope="col">Fuel use</th><th scope="col">Capacity</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {(vehicles ?? []).map((v) => (
                    <tr key={v.id}>
                      <td className="font-medium">{v.plate}</td><td>{v.model}</td><td className="capitalize">{v.fuel_type}</td>
                      <td>{Number(v.fuel_l_per_100km)} L/100 km</td><td>{v.capacity_cartons ? `${v.capacity_cartons} cartons` : ""}</td>
                      <td>{v.active ? <Badge tone="green" icon>In use</Badge> : <Badge tone="grey">Not in use</Badge>}</td>
                      <td className="text-right">
                        {!readOnly && (
                          <form action={setVehicleActive}>
                            <input type="hidden" name="id" value={v.id} /><input type="hidden" name="active" value={v.active ? "false" : "true"} />
                            {v.active ? <ConfirmSubmit label="Stop using" title={`Stop using ${v.plate}?`} message="It will not be offered for new routes. Past routes keep it." confirmLabel="Stop using" /> : <button className="btn-secondary btn-sm" type="submit">Use again</button>}
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          {!readOnly && (
            <Card title="Add a vehicle">
              <form action={saveVehicle} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Plate" htmlFor="plate"><input id="plate" name="plate" className="input uppercase" required /></Field>
                  <Field label="Fuel" htmlFor="fuel_type"><select id="fuel_type" name="fuel_type" className="input"><option value="diesel">Diesel</option><option value="petrol">Petrol</option><option value="hybrid">Hybrid</option><option value="electric">Electric</option><option value="lpg">LPG</option></select></Field>
                </div>
                <Field label="Model" htmlFor="model"><input id="model" name="model" className="input" /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Fuel use (L/100 km)" htmlFor="l100"><input id="l100" name="fuel_l_per_100km" type="number" step="0.1" min="0.1" className="input" required /></Field>
                  <Field label="Capacity (cartons)" htmlFor="cap"><input id="cap" name="capacity_cartons" type="number" min="1" className="input" /></Field>
                </div>
                <SubmitButton>Add vehicle</SubmitButton>
              </form>
            </Card>
          )}
        </div>
      )}

      {tab === "depots" && (
        <div className="grid gap-5 xl:grid-cols-[1fr_380px] [&>*]:min-w-0">
          <Card bodyClassName="p-0">
            <TableWrap>
              <table className="data-table">
                <thead><tr><th scope="col">Depot</th><th scope="col">Address</th><th scope="col">Position</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {(depots ?? []).map((d) => (
                    <tr key={d.id}>
                      <td className="font-medium">{d.name}</td><td>{d.address}</td><td className="text-muted">{Number(d.lat).toFixed(4)}, {Number(d.lon).toFixed(4)}</td>
                      <td>{d.active ? <Badge tone="green" icon>In use</Badge> : <Badge tone="grey">Not in use</Badge>}</td>
                      <td className="text-right">
                        {!readOnly && (
                          <form action={setDepotActive}>
                            <input type="hidden" name="id" value={d.id} /><input type="hidden" name="active" value={d.active ? "false" : "true"} />
                            {d.active ? <ConfirmSubmit label="Stop using" title={`Stop using ${d.name}?`} message="New routes cannot start here. Past routes keep it." confirmLabel="Stop using" /> : <button className="btn-secondary btn-sm" type="submit">Use again</button>}
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          {!readOnly && (
            <Card title="Add a depot">
              <form action={addDepot} className="space-y-3">
                <Field label="Name" htmlFor="dname"><input id="dname" name="name" className="input" required /></Field>
                <Field label="Address" htmlFor="daddr"><input id="daddr" name="address" className="input" /></Field>
                <LocationPicker height={220} />
                <SubmitButton>Add depot</SubmitButton>
              </form>
            </Card>
          )}
        </div>
      )}

      {tab === "speed" && (
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <Card title="Speed limits and alerts">
            <form action={saveSpeedSettings} className="space-y-4">
              <fieldset disabled={readOnly} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Urban limit (km/h)" htmlFor="urban" hint="Inside town zones"><input id="urban" name="urban_speed_limit_kmh" type="number" defaultValue={s.urban_speed_limit_kmh} className="input" /></Field>
                  <Field label="Highway limit (km/h)" htmlFor="hwy" hint="Outside town zones"><input id="hwy" name="highway_speed_limit_kmh" type="number" defaultValue={s.highway_speed_limit_kmh} className="input" /></Field>
                  <Field label="Alert after (seconds)" htmlFor="after" hint="Over the limit for at least this long"><input id="after" name="speed_alert_after_s" type="number" defaultValue={s.speed_alert_after_s} className="input" /></Field>
                  <Field label="Tolerance (km/h)" htmlFor="tol" hint="Ignore this much over the limit"><input id="tol" name="speed_tolerance_kmh" type="number" defaultValue={s.speed_tolerance_kmh} className="input" /></Field>
                  <Field label="Arrival radius (m)" htmlFor="arr" hint="Drivers are 'at the shop' within this distance"><input id="arr" name="arrival_radius_m" type="number" defaultValue={s.arrival_radius_m} className="input" /></Field>
                </div>
                {!readOnly && <SubmitButton>Save</SubmitButton>}
              </fieldset>
            </form>
          </Card>
          <Card title="Town zones" bodyClassName="p-0">
            <p className="px-4 pt-3 text-sm text-muted">The urban limit applies inside these areas, unless a zone has its own limit. KaiTech sets up zones for you.</p>
            <TableWrap>
              <table className="data-table">
                <thead><tr><th scope="col">Zone</th><th scope="col">Limit</th></tr></thead>
                <tbody>
                  {(zones ?? []).map((z) => <tr key={z.id}><td>{z.name}</td><td>{z.limit_kmh ? `${z.limit_kmh} km/h` : `Urban (${s.urban_speed_limit_kmh} km/h)`}</td></tr>)}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </div>
      )}

      {tab === "fuel" && (
        <Card title="Fuel price and estimate">
          <form action={saveFuelSettings} className="max-w-xl space-y-4">
            <fieldset disabled={readOnly} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Fuel price (${s.currency} per litre)`} htmlFor="price"><input id="price" name="fuel_price_per_l" type="number" step="0.001" defaultValue={s.fuel_price_per_l ?? ""} className="input" /></Field>
                <Field label="Idle allowance per stop (L)" htmlFor="idle" hint="Engine running while unloading"><input id="idle" name="idle_fuel_l_per_stop" type="number" step="0.01" defaultValue={s.idle_fuel_l_per_stop} className="input" /></Field>
              </div>
              <div className="rounded-[var(--radius-control)] bg-page p-3 text-sm">
                <p className="font-medium">How the estimate works</p>
                <p className="mt-1 text-muted">Litres = distance in km x the vehicle&apos;s L/100 km / 100, plus the idle allowance for each stop.</p>
                <p className="mt-1 text-muted">Example, 40 km in a 14.5 L/100 km truck with 8 stops: {fuelFormula({ distanceM: 40000, litresPer100Km: 14.5, stops: 8, idleLitresPerStop: Number(s.idle_fuel_l_per_stop) })}.</p>
              </div>
              {!readOnly && <SubmitButton>Save</SubmitButton>}
            </fieldset>
          </form>
        </Card>
      )}

      {tab === "integrations" && (
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <Card title="BillZilla">
            <p>{ctx.tenant.billzilla_enabled ? <Badge tone="green" icon>Connected</Badge> : <Badge tone="grey">Not connected</Badge>}</p>
            <p className="mt-2 text-sm text-muted">Confirmed invoices arrive in Ready for delivery. Delivery results, received by and proof links go back to the invoice. KaiTech connects a company on request.</p>
            {outbox && outbox.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium">Updates waiting to send</p>
                <ul className="mt-2 divide-y divide-line text-sm">
                  {outbox.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2 py-2">
                      <span>{o.target_id}<span className="block text-xs text-muted">{formatDateTime(o.created_at, ctx.tenant.time_zone)}{o.last_error ? `, ${o.last_error}` : ""}</span></span>
                      <Badge tone={o.status === "failed" ? "red" : "amber"} icon>{o.status === "failed" ? "Failed" : `Waiting, ${o.attempts} tries`}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          <Card title="KaiWorkforce">
            <p>{ctx.tenant.kaiworkforce_enabled ? <Badge tone="green" icon>Connected</Badge> : <Badge tone="grey">Not connected</Badge>}</p>
            <p className="mt-2 text-sm text-muted">
              {ctx.tenant.kaiworkforce_enabled
                ? "Drivers are tracked from clock-in to clock-out in KaiWorkforce. Set each driver's employee id under Users and roles."
                : "Without KaiWorkforce, drivers are tracked from when they start a route until the last stop is done."}
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
