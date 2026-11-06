import type { Metadata } from "next";
import Link from "next/link";
import { ConfirmSubmit, SubmitButton } from "@/components/buttons";
import { Badge, Card, EmptyState, Field, Notice, PageHeader, StatusBadge, TableWrap, Tabs } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import { requireManager } from "@/lib/tenant";
import { approveLocation, createLocation, importLocations, rejectLocation } from "./actions";
import { LocationPicker } from "./LocationPicker";
import { LocationsMap } from "./LocationsMap";

export const metadata: Metadata = { title: "Locations" };
export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = { shop: "Shop", depot: "Depot", fuel: "Fuel", hazard: "Hazard" };

type SP = Promise<{ tab?: string; notice?: string; error?: string; count?: string; problems?: string; nearby?: string; linked?: string; type?: string; q?: string }>;

export default async function LocationsPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireManager();
  const sp = await searchParams;
  const tab = sp.tab ?? "review";
  const tz = ctx.tenant.time_zone;

  const [{ data: locations }, { data: people }, { data: customers }] = await Promise.all([
    ctx.supabase
      .from("locations")
      .select("id, name, type, status, lon, lat, address, landmark_directions, photo_path, accuracy_m, created_by, created_at, expires_at, rejected_reason, customers(id, name)")
      .eq("tenant_id", ctx.tenant.id)
      .order("created_at", { ascending: false }),
    ctx.supabase.from("memberships").select("user_id, full_name").eq("tenant_id", ctx.tenant.id),
    ctx.supabase.from("customers").select("id, name, source").eq("tenant_id", ctx.tenant.id).is("location_id", null).eq("active", true).order("name"),
  ]);
  type Loc = { id: string; name: string; type: string; status: string; lon: number; lat: number; address: string | null; landmark_directions: string | null; photo_path: string | null; accuracy_m: string | null; created_by: string; created_at: string; expires_at: string | null; rejected_reason: string | null; customers: { id: string; name: string }[] };
  const all = (locations ?? []) as unknown as Loc[];
  const who = new Map((people ?? []).map((p) => [p.user_id, p.full_name]));
  const pending = all.filter((l) => l.status === "pending");
  const hazards = all.filter((l) => l.type === "hazard" && l.status === "approved");

  // Duplicate check and photo for each pin waiting for review.
  const reviewItems = tab === "review"
    ? await Promise.all(
        pending.map(async (l) => {
          const [{ data: nearby }, photo] = await Promise.all([
            ctx.supabase.rpc("nearby_locations", { p_tenant_id: ctx.tenant.id, p_lon: l.lon, p_lat: l.lat, p_radius_m: 30 }),
            l.photo_path ? ctx.supabase.storage.from("location-photos").createSignedUrl(l.photo_path, 600) : Promise.resolve({ data: null }),
          ]);
          return { ...l, nearby: ((nearby ?? []) as { id: string; name: string; status: string; distance_m: number }[]).filter((n) => n.id !== l.id), photoUrl: photo.data?.signedUrl ?? null };
        }),
      )
    : [];

  const typeFilter = sp.type ?? "";
  const q = (sp.q ?? "").toLowerCase();
  const listed = all.filter((l) => l.status !== "rejected" && (!typeFilter || l.type === typeFilter) && (!q || l.name.toLowerCase().includes(q) || (l.address ?? "").toLowerCase().includes(q)));

  return (
    <>
      <PageHeader title="Locations" description="Shops, depots, fuel stops and hazards. Drivers' pins wait here for review." />
      {sp.notice === "approved" && <div className="mb-4"><Notice tone="green">Location approved{sp.linked ? ` and linked to ${sp.linked} customer${sp.linked === "1" ? "" : "s"}` : ""}. Their invoices can now be routed.</Notice></div>}
      {sp.notice === "rejected" && <div className="mb-4"><Notice tone="grey">Pin rejected. It stays in the record but is hidden from drivers.</Notice></div>}
      {sp.notice === "added" && <div className="mb-4"><Notice tone={sp.nearby ? "amber" : "green"}>Location added.{sp.nearby ? ` Check for a duplicate: it is within 30 m of ${sp.nearby}.` : ""}</Notice></div>}
      {sp.notice === "imported" && <div className="mb-4"><Notice tone={sp.problems ? "amber" : "green"}>{sp.count} locations imported.{sp.problems ? ` ${sp.problems}` : ""}</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="red">{sp.error}</Notice></div>}

      <Tabs
        current={tab}
        tabs={[
          { key: "review", label: "Review queue", href: "/locations", count: pending.length },
          { key: "all", label: "All locations", href: "/locations?tab=all" },
          { key: "hazards", label: "Hazards", href: "/locations?tab=hazards", count: hazards.length },
          ...(ctx.isAdmin ? [{ key: "import", label: "Import CSV", href: "/locations?tab=import" }] : []),
        ]}
      />

      {tab === "review" && (
        reviewItems.length === 0 ? (
          <Card><EmptyState title="No pins waiting for review">When a driver drops a pin for a new shop, it appears here.</EmptyState></Card>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[420px_1fr] [&>*]:min-w-0">
            <Card title="On the map" bodyClassName="p-0">
              <LocationsMap locations={[...pending, ...all.filter((l) => l.status === "approved" && reviewItems.some((r) => r.nearby.some((n) => n.id === l.id)))]} height={520} />
            </Card>
            <div className="space-y-4">
              {reviewItems.map((l) => (
                <Card key={l.id} title={<span className="flex items-center gap-2">{l.name} <StatusBadge status="pending" /></span>} actions={<Link className="link text-sm" href={`/locations/${l.id}`}>Edit</Link>}>
                  <div className="grid gap-4 md:grid-cols-[1fr_200px]">
                    <div className="space-y-1 text-sm">
                      <p><span className="text-muted">Type:</span> {TYPE_LABEL[l.type]}</p>
                      <p><span className="text-muted">Dropped by:</span> {who.get(l.created_by) ?? "Unknown"}, {formatDateTime(l.created_at, tz)}</p>
                      <p><span className="text-muted">GPS accuracy:</span> {l.accuracy_m ? `${Math.round(Number(l.accuracy_m))} m` : "Not recorded"}</p>
                      <p><span className="text-muted">Position:</span> {l.lat.toFixed(5)}, {l.lon.toFixed(5)}</p>
                      {l.landmark_directions && <p><span className="text-muted">Directions:</span> {l.landmark_directions}</p>}
                    </div>
                    {l.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={l.photoUrl} alt={`Photo of ${l.name}`} className="h-36 w-full rounded-[var(--radius-control)] border border-line object-cover" />
                    ) : (
                      <div className="flex h-36 items-center justify-center rounded-[var(--radius-control)] border border-dashed border-line text-sm text-muted">No photo</div>
                    )}
                  </div>
                  {l.nearby.length > 0 && (
                    <div className="mt-3"><Notice tone="amber"><strong>Possible duplicate.</strong> Within 30 m: {l.nearby.map((n) => `${n.name} (${Math.round(n.distance_m)} m, ${n.status === "approved" ? "approved" : "waiting for review"})`).join("; ")}.</Notice></div>
                  )}
                  {ctx.isAdmin ? (
                    <div className="mt-4 grid gap-4 border-t border-line pt-4 md:grid-cols-[1fr_auto]">
                      <form action={approveLocation} className="space-y-3">
                        <input type="hidden" name="id" value={l.id} />
                        <Field label="Name" htmlFor={`name-${l.id}`}><input id={`name-${l.id}`} name="name" defaultValue={l.name} className="input" /></Field>
                        {l.type === "shop" && (
                          <Field label="Link to BillZilla customers" htmlFor={`cust-${l.id}`} hint="Hold Ctrl or Cmd to choose more than one. Only customers without a location are listed.">
                            <select id={`cust-${l.id}`} name="customerIds" multiple className="input h-28 py-1" defaultValue={(customers ?? []).filter((c) => c.name.toLowerCase() === l.name.toLowerCase()).map((c) => c.id)}>
                              {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          </Field>
                        )}
                        <SubmitButton pendingLabel="Approving">Approve</SubmitButton>
                      </form>
                      <form action={rejectLocation} className="space-y-3 md:w-56">
                        <input type="hidden" name="id" value={l.id} />
                        <Field label="Reason (optional)" htmlFor={`reason-${l.id}`}><input id={`reason-${l.id}`} name="reason" className="input" placeholder="For example: duplicate" /></Field>
                        <ConfirmSubmit label="Reject" title={`Reject ${l.name}?`} message="The pin is hidden from drivers and kept in the record. You can add it again later." confirmLabel="Reject pin" className="btn-danger" />
                      </form>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted">An Owner or Admin approves pins.</p>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )
      )}

      {tab === "all" && (
        <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[1fr_380px] [&>*]:min-w-0">
            <Card title="Map" bodyClassName="p-0"><LocationsMap locations={listed} height={460} /></Card>
            {ctx.isAdmin && (
              <Card title="Add a location">
                <form action={createLocation} className="space-y-3">
                  <Field label="Name" htmlFor="new-name"><input id="new-name" name="name" className="input" required /></Field>
                  <Field label="Type" htmlFor="new-type">
                    <select id="new-type" name="type" className="input"><option value="shop">Shop</option><option value="depot">Depot</option><option value="fuel">Fuel</option></select>
                  </Field>
                  <LocationPicker height={200} />
                  <Field label="Directions" htmlFor="new-dir"><input id="new-dir" name="landmark_directions" className="input" placeholder="Landmarks that help the driver" /></Field>
                  <SubmitButton>Add location</SubmitButton>
                </form>
              </Card>
            )}
          </div>
          <Card
            title={`${listed.length} locations`}
            actions={
              <form className="flex w-full flex-wrap gap-2 sm:w-auto">
                <input type="hidden" name="tab" value="all" />
                <label htmlFor="q" className="sr-only">Search</label>
                <input id="q" name="q" defaultValue={sp.q} placeholder="Search" className="input min-h-9 w-full min-w-0 flex-1 sm:w-40 sm:flex-none" />
                <label htmlFor="type" className="sr-only">Type</label>
                <select id="type" name="type" defaultValue={typeFilter} className="input min-h-9 w-32 flex-none">
                  <option value="">All types</option><option value="shop">Shops</option><option value="depot">Depots</option><option value="fuel">Fuel</option><option value="hazard">Hazards</option>
                </select>
                <button className="btn-secondary btn-sm" type="submit">Filter</button>
              </form>
            }
            bodyClassName="p-0"
          >
            <TableWrap>
              <table className="data-table">
                <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Customers</th><th scope="col">Address</th><th scope="col">Added</th></tr></thead>
                <tbody>
                  {listed.map((l) => (
                    <tr key={l.id}>
                      <td><Link className="link" href={`/locations/${l.id}`}>{l.name}</Link></td>
                      <td>{TYPE_LABEL[l.type]}</td>
                      <td><StatusBadge status={l.status} /></td>
                      <td>{l.customers.length ? l.customers.map((c) => c.name).join(", ") : <span className="text-muted">None</span>}</td>
                      <td>{l.address}</td>
                      <td>{formatDate(l.created_at, tz)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </div>
      )}

      {tab === "hazards" && (
        <div className="grid gap-5 xl:grid-cols-[1fr_380px] [&>*]:min-w-0">
          <Card title="Hazards" bodyClassName="p-0">
            {hazards.length === 0 ? <EmptyState title="No hazards on the map" /> : (
              <TableWrap>
                <table className="data-table">
                  <thead><tr><th scope="col">Hazard</th><th scope="col">Details</th><th scope="col">Expires</th></tr></thead>
                  <tbody>
                    {hazards.map((h) => {
                      const expired = h.expires_at && new Date(h.expires_at) < new Date();
                      return (
                        <tr key={h.id}>
                          <td><Link className="link" href={`/locations/${h.id}`}>{h.name}</Link></td>
                          <td>{h.landmark_directions}</td>
                          <td>{h.expires_at ? <Badge tone={expired ? "grey" : "amber"}>{expired ? "Expired " : ""}{formatDate(h.expires_at, tz)}</Badge> : "No expiry"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
          {ctx.isAdmin && (
            <Card title="Add a hazard">
              <form action={createLocation} className="space-y-3">
                <input type="hidden" name="type" value="hazard" />
                <Field label="What is it" htmlFor="hz-name"><input id="hz-name" name="name" className="input" placeholder="For example: flooded crossing" required /></Field>
                <LocationPicker height={200} />
                <Field label="Details for drivers" htmlFor="hz-dir"><input id="hz-dir" name="landmark_directions" className="input" /></Field>
                <Field label="Expires" htmlFor="hz-exp" hint="Hidden from drivers after this date. Leave empty for no expiry."><input id="hz-exp" name="expires_at" type="date" className="input" /></Field>
                <SubmitButton>Add hazard</SubmitButton>
              </form>
            </Card>
          )}
        </div>
      )}

      {tab === "import" && ctx.isAdmin && (
        <Card title="Import locations from a spreadsheet">
          <form action={importLocations} className="max-w-xl space-y-4">
            <p className="text-sm text-muted">
              Save as CSV with the columns <strong>name</strong>, <strong>type</strong> (shop, depot, fuel or hazard), <strong>latitude</strong> and <strong>longitude</strong>.
              Optional: <strong>address</strong>, <strong>directions</strong>, and <strong>billzilla_customer_id</strong> to link a customer. Imported locations are approved straight away; rows within 30 m of an existing location are listed afterwards so you can check them.
            </p>
            <Field label="CSV file" htmlFor="loc-file"><input id="loc-file" name="file" type="file" accept=".csv,text/csv" className="input py-2" required /></Field>
            <SubmitButton pendingLabel="Importing">Import locations</SubmitButton>
          </form>
        </Card>
      )}
    </>
  );
}
