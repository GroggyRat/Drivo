import type pg from "pg";

// Two tenants with the same shape, so every isolation test can run both ways.
// Fixed ids keep failures easy to read: tenant A ids start with "a", B with "b".
const id = (p: "a" | "b", n: string) => `${p}0000000-0000-4000-8000-0000000000${n}`;

function ids(p: "a" | "b") {
  return {
    tenant: id(p, "00"),
    owner: id(p, "01"),
    admin: id(p, "02"),
    dispatcher: id(p, "03"),
    driver1: id(p, "04"),
    driver2: id(p, "05"),
    depot: id(p, "10"),
    vehicle: id(p, "11"),
    zone: id(p, "12"),
    shop1: id(p, "20"),
    shop2: id(p, "21"),
    pinByDriver1: id(p, "22"),
    pinByDriver2: id(p, "23"),
    expiredHazard: id(p, "24"),
    customerLinked: id(p, "30"),
    customerNoLocation: id(p, "31"),
    orderLinked: id(p, "40"),
    orderNoLocation: id(p, "41"),
    orderUnrouted: id(p, "42"),
    sentRoute: id(p, "50"),
    draftRoute: id(p, "51"),
    sentStop: id(p, "52"),
    draftStop: id(p, "53"),
    proof: id(p, "60"),
    shift: id(p, "70"),
    gpsBatch: id(p, "71"),
    trip: id(p, "72"),
    speedEvent: id(p, "73"),
    roadAlert: id(p, "74"),
    payment: id(p, "75"),
  };
}

export const A = ids("a");
export const B = ids("b");
export const PLATFORM_ADMIN = "f0000000-0000-4000-8000-0000000000f1";
/** Signed in, but a member of no tenant. */
export const STRANGER = "f0000000-0000-4000-8000-0000000000f2";

// Centre of each tenant's area: A in Suva, B in Lautoka.
const CENTRE = { a: [178.4419, -18.1416], b: [177.4503, -17.6088] } as const;

function tenantSql(p: "a" | "b"): string {
  const t = ids(p);
  const [lon, lat] = CENTRE[p];
  const pt = (dLon: number, dLat: number) =>
    `extensions.st_setsrid(extensions.st_makepoint(${lon + dLon}, ${lat + dLat}), 4326)::extensions.geography`;
  const zone = `extensions.st_multi(extensions.st_makeenvelope(${lon - 0.05}, ${lat - 0.05}, ${lon + 0.05}, ${lat + 0.05}, 4326))::extensions.geography`;
  const name = p === "a" ? "Tenant A" : "Tenant B";
  const user = (uid: string, role: string, label: string) => `
    insert into auth.users (id, email, aud, role) values ('${uid}', '${label}@${p}.test', 'authenticated', 'authenticated');
    insert into public.memberships (tenant_id, user_id, role, full_name, email) values ('${t.tenant}', '${uid}', '${role}', '${name} ${label}', '${label}@${p}.test');`;

  return `
    insert into public.tenants (id, name, slug) values ('${t.tenant}', '${name}', 'tenant-${p}');
    ${user(t.owner, "owner", "owner")}
    ${user(t.admin, "admin", "admin")}
    ${user(t.dispatcher, "dispatcher", "dispatcher")}
    ${user(t.driver1, "driver", "driver1")}
    ${user(t.driver2, "driver", "driver2")}

    insert into public.depots (id, tenant_id, name, point) values ('${t.depot}', '${t.tenant}', 'Main depot', ${pt(0, 0)});
    insert into public.vehicles (id, tenant_id, plate, model, fuel_l_per_100km) values ('${t.vehicle}', '${t.tenant}', '${p.toUpperCase()}A 101', 'Isuzu NPR', 14.5);
    insert into public.speed_zones (id, tenant_id, name, area) values ('${t.zone}', '${t.tenant}', 'Town', ${zone});

    insert into public.locations (id, tenant_id, name, type, point, status, created_by, approved_by, approved_at) values
      ('${t.shop1}', '${t.tenant}', 'Shop one', 'shop', ${pt(0.01, 0)}, 'approved', '${t.admin}', '${t.admin}', now()),
      ('${t.shop2}', '${t.tenant}', 'Shop two', 'shop', ${pt(0.02, 0)}, 'approved', '${t.admin}', '${t.admin}', now());
    insert into public.locations (id, tenant_id, name, type, point, status, created_by) values
      ('${t.pinByDriver1}', '${t.tenant}', 'Pin by driver one', 'shop', ${pt(0.03, 0)}, 'pending', '${t.driver1}'),
      ('${t.pinByDriver2}', '${t.tenant}', 'Pin by driver two', 'shop', ${pt(0.04, 0)}, 'pending', '${t.driver2}');
    insert into public.locations (id, tenant_id, name, type, point, status, created_by, approved_by, approved_at, expires_at) values
      ('${t.expiredHazard}', '${t.tenant}', 'Old roadworks', 'hazard', ${pt(0.05, 0)}, 'approved', '${t.admin}', '${t.admin}', now(), now() - interval '1 day');

    insert into public.customers (id, tenant_id, source, billzilla_customer_id, name, location_id) values
      ('${t.customerLinked}', '${t.tenant}', 'billzilla', 'BZ-C-${p}1', 'Linked customer', '${t.shop1}');
    insert into public.customers (id, tenant_id, source, name) values
      ('${t.customerNoLocation}', '${t.tenant}', 'manual', 'Customer with no pin');

    insert into public.orders (id, tenant_id, source, billzilla_invoice_id, reference, customer_id, customer_name, cartons, billzilla_status) values
      ('${t.orderLinked}', '${t.tenant}', 'billzilla', 'BZ-I-${p}1', 'INV-${p}1', '${t.customerLinked}', 'Linked customer', 12, 'confirmed'),
      ('${t.orderUnrouted}', '${t.tenant}', 'billzilla', 'BZ-I-${p}3', 'INV-${p}3', '${t.customerLinked}', 'Linked customer', 4, 'confirmed');
    insert into public.orders (id, tenant_id, source, reference, customer_id, customer_name, cartons) values
      ('${t.orderNoLocation}', '${t.tenant}', 'manual', 'ORD-${p}2', '${t.customerNoLocation}', 'Customer with no pin', 3);

    insert into public.routes (id, tenant_id, route_date, depot_id, status, driver_id, vehicle_id, created_by, sent_at) values
      ('${t.sentRoute}', '${t.tenant}', current_date, '${t.depot}', 'sent', '${t.driver1}', '${t.vehicle}', '${t.dispatcher}', now());
    insert into public.routes (id, tenant_id, route_date, depot_id, status, driver_id, created_by) values
      ('${t.draftRoute}', '${t.tenant}', current_date + 1, '${t.depot}', 'draft', '${t.driver2}', '${t.dispatcher}');
    insert into public.route_stops (id, tenant_id, route_id, sequence, location_id, order_id) values
      ('${t.sentStop}', '${t.tenant}', '${t.sentRoute}', 1, '${t.shop1}', '${t.orderLinked}'),
      ('${t.draftStop}', '${t.tenant}', '${t.draftRoute}', 1, '${t.shop2}', null);
    insert into public.proofs_of_delivery (id, tenant_id, stop_id, delivered_in_full, received_by, captured_by, captured_at, photo_path) values
      ('${t.proof}', '${t.tenant}', '${t.sentStop}', true, 'Shop manager', '${t.driver1}', now(), '${t.tenant}/${t.sentStop}/photo.jpg');

    insert into public.shifts (id, tenant_id, driver_id, source, started_at) values
      ('${t.shift}', '${t.tenant}', '${t.driver1}', 'route', now() - interval '1 hour');
    insert into public.gps_batches (id, tenant_id, driver_id, shift_id, recorded_from, recorded_to, point_count, points) values
      ('${t.gpsBatch}', '${t.tenant}', '${t.driver1}', '${t.shift}', now() - interval '1 minute', now(), 1, '[[0, ${lon}, ${lat}, 5, 10, 90]]');
    insert into public.trips (id, tenant_id, driver_id, trip_date, distance_m, duration_s) values
      ('${t.trip}', '${t.tenant}', '${t.driver1}', current_date - 1, 42000, 18000);
    insert into public.speed_events (id, tenant_id, driver_id, route_id, started_at, duration_s, max_speed_kmh, limit_kmh, point) values
      ('${t.speedEvent}', '${t.tenant}', '${t.driver1}', '${t.sentRoute}', now(), 14, 68, 50, ${pt(0, 0)});
    insert into public.road_alerts (id, tenant_id, reported_by, kind, point, expires_at) values
      ('${t.roadAlert}', '${t.tenant}', '${t.driver1}', 'police', ${pt(0.002, 0)}, now() + interval '2 hours');
    update public.tenant_billing set monthly_fee = 80, next_due_on = current_date + 10 where tenant_id = '${t.tenant}';
    insert into public.tenant_payments (id, tenant_id, amount, paid_on, due_on) values
      ('${t.payment}', '${t.tenant}', 80, current_date - 20, current_date - 20);
    insert into public.xero_connections (tenant_id, xero_tenant_id, org_name, token_ciphertext, import_from) values
      ('${t.tenant}', 'xero-org-${p}', '${name} Ltd', 'encrypted-tokens-${p}', current_date - 3);
    insert into public.segment_speeds (tenant_id, osm_way_id, forward, weekday, hour, sample_count, mean_speed_kmh) values
      ('${t.tenant}', 1000, true, 1, 8, 20, 32.5);

    insert into public.integration_outbox (tenant_id, provider, event, target_id, payload) values
      ('${t.tenant}', 'billzilla', 'delivery.updated', 'BZ-I-${p}1', '{}');
    insert into public.integration_deliveries (tenant_id, provider, delivery_id, event) values
      ('${t.tenant}', 'billzilla', 'delivery-${p}1', 'invoice.confirmed');

    insert into storage.objects (bucket_id, name) values
      ('location-photos', '${t.tenant}/${t.shop1}.jpg'),
      ('delivery-proofs', '${t.tenant}/${t.sentStop}/photo.jpg');
  `;
}

export async function loadFixture(client: pg.Client) {
  await client.query(tenantSql("a"));
  await client.query(tenantSql("b"));
  await client.query(`
    insert into auth.users (id, email, aud, role) values
      ('${PLATFORM_ADMIN}', 'platform@kaitech.test', 'authenticated', 'authenticated'),
      ('${STRANGER}', 'stranger@example.test', 'authenticated', 'authenticated');
    insert into public.platform_admins (user_id, full_name, email) values ('${PLATFORM_ADMIN}', 'Platform Owner', 'platform@kaitech.test');
  `);
}

/** Every tenant's tables, with the column that holds the tenant id. */
export const tenantColumn = (table: string) => (table === "tenants" ? "id" : "tenant_id");
