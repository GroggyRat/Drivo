-- Drivo schema: tenants, people, places, vehicles, orders, routes, tracking.
--
-- Rules every table follows:
--   * Every tenant-owned row has tenant_id. tenants and platform_admins are
--     the only tables without it.
--   * Child rows point at parents with composite (id, tenant_id) foreign
--     keys, so a row can never reference another tenant's data, even through
--     a bug in application code or a service-role call.
--   * Points are geography(Point, 4326), longitude -180 to 180. Fiji crosses
--     the 180 degree meridian (Taveuni, Lau Group); geography measures
--     distances across it correctly, so no special handling is stored.
--   * Raw GPS points are never one row each: phones upload batches
--     (gps_batches, one row per upload), and the nightly job turns a day into
--     one trips row and archives the raw points to R2.

create extension if not exists postgis with schema extensions;

create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.tenant_status as enum ('active', 'suspended');
create type public.member_role as enum ('owner', 'admin', 'dispatcher', 'driver');
create type public.location_type as enum ('shop', 'depot', 'fuel', 'hazard');
create type public.location_status as enum ('pending', 'approved', 'rejected');
create type public.fuel_type as enum ('diesel', 'petrol', 'electric', 'hybrid', 'lpg');
create type public.record_source as enum ('billzilla', 'manual', 'csv');
create type public.delivery_status as enum (
  'ready', 'planned', 'out_for_delivery', 'delivered', 'partially_delivered', 'failed', 'cancelled'
);
create type public.route_status as enum ('draft', 'sent', 'in_progress', 'completed', 'cancelled');
create type public.optimise_for as enum ('lowest_fuel', 'fastest', 'shortest');
create type public.stop_status as enum (
  'scheduled', 'arrived', 'delivered', 'partially_delivered', 'failed', 'skipped'
);
-- What started a tracking shift: a KaiWorkforce clock-in, or (for tenants
-- without KaiWorkforce) the driver starting a route.
create type public.shift_source as enum ('kaiworkforce', 'route');

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 200),
  -- Short web name for the branded sign-in page.
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$' and slug !~ '--'),
  status public.tenant_status not null default 'active',
  suspended_at timestamptz,
  time_zone text not null default 'Pacific/Fiji',
  contact_email text check (contact_email is null or contact_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  logo_path text,
  -- Integrations are optional. A tenant can use Drivo on its own.
  billzilla_enabled boolean not null default false,
  kaiworkforce_enabled boolean not null default false,
  -- Ids of this tenant in the other KaiTech products. Webhooks find the
  -- tenant by these, so only the platform can set them (platform_link_tenant).
  billzilla_org_id text unique,
  kaiworkforce_company_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenants_suspended_at check ((status = 'suspended') = (suspended_at is not null))
);
create trigger tenants_touch before update on public.tenants
  for each row execute function app.touch_updated_at();

-- KaiTech staff who run the platform. They belong to no tenant.
create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 200),
  email text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Memberships: one row per person per tenant. A person can belong to more
-- than one tenant and picks which one to work in.
-- ---------------------------------------------------------------------------
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  full_name text not null check (char_length(trim(full_name)) between 1 and 200),
  email text,
  phone text,
  -- The person's employee id in KaiWorkforce, for clock-in webhooks.
  kaiworkforce_employee_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (id, tenant_id),
  unique (tenant_id, kaiworkforce_employee_id)
);
-- One active Owner per tenant.
create unique index memberships_one_owner on public.memberships (tenant_id) where role = 'owner' and active;
create index memberships_user on public.memberships (user_id) where active;
create trigger memberships_touch before update on public.memberships
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Tenant settings: one row per tenant, made by a trigger on tenants.
-- ---------------------------------------------------------------------------
create table public.tenant_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  urban_speed_limit_kmh integer not null default 50 check (urban_speed_limit_kmh between 10 and 130),
  highway_speed_limit_kmh integer not null default 80 check (highway_speed_limit_kmh between 10 and 130),
  -- A speed event is recorded when a driver is over the limit for longer
  -- than this, by more than the tolerance.
  speed_alert_after_s integer not null default 10 check (speed_alert_after_s between 1 and 120),
  speed_tolerance_kmh integer not null default 0 check (speed_tolerance_kmh between 0 and 30),
  -- Fuel estimate = km x L/100 km / 100 + idle allowance per stop.
  fuel_price_per_l numeric(8, 3) check (fuel_price_per_l is null or fuel_price_per_l > 0),
  idle_fuel_l_per_stop numeric(6, 3) not null default 0.1 check (idle_fuel_l_per_stop >= 0),
  currency text not null default 'FJD' check (currency ~ '^[A-Z]{3}$'),
  arrival_radius_m integer not null default 50 check (arrival_radius_m between 10 and 500),
  duplicate_radius_m integer not null default 30 check (duplicate_radius_m between 5 and 500),
  updated_at timestamptz not null default now()
);
create trigger tenant_settings_touch before update on public.tenant_settings
  for each row execute function app.touch_updated_at();

create or replace function app.tenants_add_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tenant_settings (tenant_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
create trigger tenants_add_settings after insert on public.tenants
  for each row execute function app.tenants_add_settings();

-- ---------------------------------------------------------------------------
-- Speed zones. Inside a zone the zone's limit applies (or the tenant's urban
-- limit when the zone has none); outside every zone, the highway limit.
-- ---------------------------------------------------------------------------
create table public.speed_zones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 200),
  limit_kmh integer check (limit_kmh is null or limit_kmh between 10 and 130),
  area extensions.geography(MultiPolygon, 4326) not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, tenant_id)
);
create index speed_zones_area on public.speed_zones using gist (area);
create index speed_zones_tenant on public.speed_zones (tenant_id) where active;

-- ---------------------------------------------------------------------------
-- Depots
-- ---------------------------------------------------------------------------
create table public.depots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 200),
  address text,
  point extensions.geography(Point, 4326) not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, name)
);
create index depots_point on public.depots using gist (point);

-- ---------------------------------------------------------------------------
-- Locations: shops, depots, fuel stops and hazards, pinned on the map.
-- Driver pins start pending and an Owner or Admin approves them.
-- Written only through the functions in *_functions.sql.
-- ---------------------------------------------------------------------------
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 200),
  type public.location_type not null,
  point extensions.geography(Point, 4326) not null,
  address text,
  landmark_directions text check (landmark_directions is null or char_length(landmark_directions) <= 2000),
  photo_path text,
  accuracy_m numeric(6, 1) check (accuracy_m is null or accuracy_m >= 0),
  status public.location_status not null default 'pending',
  created_by uuid not null,
  approved_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  rejected_reason text,
  -- Hazards (roadworks, flooding) can expire. Other types never do.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (tenant_id, created_by) references public.memberships (tenant_id, user_id),
  foreign key (tenant_id, approved_by) references public.memberships (tenant_id, user_id),
  foreign key (tenant_id, rejected_by) references public.memberships (tenant_id, user_id),
  constraint locations_expiry_for_hazards check (expires_at is null or type = 'hazard'),
  constraint locations_approved check ((status = 'approved') = (approved_by is not null and approved_at is not null)),
  constraint locations_rejected check ((status = 'rejected') = (rejected_by is not null and rejected_at is not null)),
  constraint locations_photo_in_tenant check (photo_path is null or photo_path like tenant_id::text || '/%')
);
create index locations_point on public.locations using gist (point);
create index locations_tenant_status on public.locations (tenant_id, status);
create trigger locations_touch before update on public.locations
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Customers. Mirrored from BillZilla, or added in Drivo by tenants without
-- BillZilla. Each customer delivers to one approved location; one location
-- can serve several customers (two accounts at the same shop).
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  source public.record_source not null default 'manual',
  billzilla_customer_id text,
  name text not null check (char_length(trim(name)) between 1 and 200),
  phone text,
  address text,
  location_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, billzilla_customer_id),
  foreign key (location_id, tenant_id) references public.locations (id, tenant_id),
  constraint customers_billzilla_id check ((source = 'billzilla') = (billzilla_customer_id is not null))
);
create index customers_location on public.customers (location_id);
create trigger customers_touch before update on public.customers
  for each row execute function app.touch_updated_at();

-- A customer can only be linked to an approved shop.
create or replace function app.customers_check_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.location_id is not null and not exists (
    select 1 from public.locations l
    where l.id = new.location_id and l.tenant_id = new.tenant_id
      and l.status = 'approved' and l.type = 'shop'
  ) then
    raise exception 'A customer can only be linked to an approved shop location'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger customers_check_location before insert or update of location_id on public.customers
  for each row execute function app.customers_check_location();

-- ---------------------------------------------------------------------------
-- Vehicles
-- ---------------------------------------------------------------------------
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  plate text not null check (plate ~ '^[A-Z0-9 ]{2,12}$'),
  model text,
  fuel_type public.fuel_type not null default 'diesel',
  fuel_l_per_100km numeric(5, 2) not null check (fuel_l_per_100km > 0 and fuel_l_per_100km < 100),
  capacity_cartons integer check (capacity_cartons is null or capacity_cartons > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, plate)
);

-- ---------------------------------------------------------------------------
-- Orders: what to deliver. BillZilla invoices (source billzilla) arrive by
-- webhook or the "Sync from BillZilla" pull; other tenants add orders by
-- hand or CSV. An order is "Ready for delivery" when its customer has an
-- approved location.
-- ---------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  source public.record_source not null default 'manual',
  billzilla_invoice_id text,
  -- Invoice or order number as people know it.
  reference text not null check (char_length(trim(reference)) between 1 and 100),
  customer_id uuid not null,
  -- Customer name at the time of the invoice.
  customer_name text not null,
  cartons integer not null default 0 check (cartons >= 0),
  line_items jsonb not null default '[]' check (jsonb_typeof(line_items) = 'array'),
  total_amount numeric(12, 2),
  currency text not null default 'FJD' check (currency ~ '^[A-Z]{3}$'),
  -- The invoice status in BillZilla, as sent (for example "confirmed").
  billzilla_status text,
  delivery_status public.delivery_status not null default 'ready',
  confirmed_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, billzilla_invoice_id),
  unique (tenant_id, reference),
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id),
  constraint orders_billzilla_id check ((source = 'billzilla') = (billzilla_invoice_id is not null))
);
create index orders_tenant_status on public.orders (tenant_id, delivery_status);
create index orders_customer on public.orders (customer_id);
create trigger orders_touch before update on public.orders
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Routes and stops
-- ---------------------------------------------------------------------------
create table public.routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text,
  route_date date not null,
  depot_id uuid not null,
  status public.route_status not null default 'draft',
  optimise_for public.optimise_for not null default 'lowest_fuel',
  departure_at timestamptz,
  driver_id uuid,
  vehicle_id uuid,
  planned_distance_m integer check (planned_distance_m is null or planned_distance_m >= 0),
  planned_duration_s integer check (planned_duration_s is null or planned_duration_s >= 0),
  fuel_estimate_l numeric(8, 2) check (fuel_estimate_l is null or fuel_estimate_l >= 0),
  geometry extensions.geography(LineString, 4326),
  created_by uuid not null,
  sent_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (depot_id, tenant_id) references public.depots (id, tenant_id),
  foreign key (vehicle_id, tenant_id) references public.vehicles (id, tenant_id),
  foreign key (tenant_id, driver_id) references public.memberships (tenant_id, user_id),
  foreign key (tenant_id, created_by) references public.memberships (tenant_id, user_id),
  -- A route can only leave draft with a driver and a vehicle.
  constraint routes_assigned check (status in ('draft', 'cancelled') or (driver_id is not null and vehicle_id is not null))
);
create index routes_tenant_date on public.routes (tenant_id, route_date);
create index routes_driver on public.routes (driver_id, route_date);
create trigger routes_touch before update on public.routes
  for each row execute function app.touch_updated_at();

create table public.route_stops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  route_id uuid not null,
  sequence integer not null check (sequence > 0),
  location_id uuid not null,
  order_id uuid,
  planned_eta timestamptz,
  arrived_at timestamptz,
  completed_at timestamptz,
  status public.stop_status not null default 'scheduled',
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  -- Deferrable so a reorder can swap sequences in one transaction.
  constraint route_stops_sequence unique (route_id, sequence) deferrable initially immediate,
  foreign key (route_id, tenant_id) references public.routes (id, tenant_id) on delete cascade,
  foreign key (location_id, tenant_id) references public.locations (id, tenant_id),
  foreign key (order_id, tenant_id) references public.orders (id, tenant_id)
);
create index route_stops_order on public.route_stops (order_id);
create index route_stops_location on public.route_stops (location_id);
create trigger route_stops_touch before update on public.route_stops
  for each row execute function app.touch_updated_at();

-- Stops go to approved, non-hazard locations. An order can only be added
-- when its customer is linked to a location, and the stop must be there.
create or replace function app.route_stops_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_location uuid;
begin
  if not exists (
    select 1 from public.locations l
    where l.id = new.location_id and l.tenant_id = new.tenant_id
      and l.status = 'approved' and l.type <> 'hazard'
  ) then
    raise exception 'A stop must be at an approved location' using errcode = '23514';
  end if;
  if new.order_id is not null then
    select c.location_id into v_customer_location
    from public.orders o join public.customers c on c.id = o.customer_id
    where o.id = new.order_id and o.tenant_id = new.tenant_id;
    if v_customer_location is null then
      raise exception 'This customer has no location yet. Add a pin before adding the order to a route'
        using errcode = '23514';
    end if;
    if v_customer_location <> new.location_id then
      raise exception 'The stop location must be the customer''s location' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger route_stops_check before insert or update of location_id, order_id on public.route_stops
  for each row execute function app.route_stops_check();

-- ---------------------------------------------------------------------------
-- Proof of delivery: one per stop.
-- ---------------------------------------------------------------------------
create table public.proofs_of_delivery (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  stop_id uuid not null unique,
  photo_path text,
  signature_path text,
  received_by text,
  delivered_in_full boolean not null,
  partial_notes text,
  captured_by uuid not null,
  captured_at timestamptz not null,
  point extensions.geography(Point, 4326),
  accuracy_m numeric(6, 1),
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (stop_id, tenant_id) references public.route_stops (id, tenant_id),
  foreign key (tenant_id, captured_by) references public.memberships (tenant_id, user_id),
  constraint pod_partial_notes check (delivered_in_full or char_length(trim(coalesce(partial_notes, ''))) > 0),
  constraint pod_paths_in_tenant check (
    (photo_path is null or photo_path like tenant_id::text || '/%')
    and (signature_path is null or signature_path like tenant_id::text || '/%')
  )
);

-- ---------------------------------------------------------------------------
-- Tracking. A driver is tracked only during a shift.
-- ---------------------------------------------------------------------------
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  driver_id uuid not null,
  source public.shift_source not null,
  kaiworkforce_shift_id text,
  route_id uuid,
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (tenant_id, driver_id) references public.memberships (tenant_id, user_id),
  foreign key (route_id, tenant_id) references public.routes (id, tenant_id),
  constraint shifts_order check (ended_at is null or ended_at >= started_at)
);
-- At most one open shift per driver.
create unique index shifts_one_open on public.shifts (tenant_id, driver_id) where ended_at is null;
create index shifts_driver_started on public.shifts (tenant_id, driver_id, started_at desc);

-- One row per upload from the phone (about 30 to 60 seconds of points).
-- The id is made on the phone so a retried upload is not stored twice.
-- points is an array of [epoch_ms, lon, lat, accuracy_m, speed_mps, heading_deg];
-- Postgres compresses it on disk. Rows are deleted after the nightly job
-- archives them to R2 (archived_at).
create table public.gps_batches (
  id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  driver_id uuid not null,
  shift_id uuid,
  vehicle_id uuid,
  recorded_from timestamptz not null,
  recorded_to timestamptz not null,
  point_count integer not null check (point_count between 1 and 2000),
  points jsonb not null check (jsonb_typeof(points) = 'array'),
  received_at timestamptz not null default now(),
  archived_at timestamptz,
  foreign key (tenant_id, driver_id) references public.memberships (tenant_id, user_id),
  foreign key (shift_id, tenant_id) references public.shifts (id, tenant_id),
  foreign key (vehicle_id, tenant_id) references public.vehicles (id, tenant_id),
  constraint gps_batches_order check (recorded_to >= recorded_from)
);
create index gps_batches_driver_time on public.gps_batches (tenant_id, driver_id, recorded_from);
create index gps_batches_unarchived on public.gps_batches (recorded_from) where archived_at is null;

-- A driver's day, compressed by the nightly job.
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  driver_id uuid not null,
  vehicle_id uuid,
  trip_date date not null,
  geometry extensions.geography(LineString, 4326),
  distance_m integer not null default 0 check (distance_m >= 0),
  duration_s integer not null default 0 check (duration_s >= 0),
  moving_s integer not null default 0 check (moving_s >= 0),
  idle_s integer not null default 0 check (idle_s >= 0),
  max_speed_kmh numeric(5, 1),
  point_count integer not null default 0,
  raw_archive_path text,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, driver_id, trip_date),
  foreign key (tenant_id, driver_id) references public.memberships (tenant_id, user_id),
  foreign key (vehicle_id, tenant_id) references public.vehicles (id, tenant_id)
);

create table public.speed_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  driver_id uuid not null,
  vehicle_id uuid,
  route_id uuid,
  started_at timestamptz not null,
  duration_s integer not null check (duration_s >= 0),
  max_speed_kmh numeric(5, 1) not null check (max_speed_kmh >= 0),
  limit_kmh integer not null check (limit_kmh > 0),
  zone_name text,
  point extensions.geography(Point, 4326) not null,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (tenant_id, driver_id) references public.memberships (tenant_id, user_id),
  foreign key (vehicle_id, tenant_id) references public.vehicles (id, tenant_id),
  foreign key (route_id, tenant_id) references public.routes (id, tenant_id),
  foreign key (tenant_id, acknowledged_by) references public.memberships (tenant_id, user_id),
  constraint speed_events_ack check ((acknowledged_by is null) = (acknowledged_at is null))
);
create index speed_events_tenant_time on public.speed_events (tenant_id, started_at desc);
create index speed_events_open on public.speed_events (tenant_id) where acknowledged_at is null;

-- Average speeds per OSM way, direction, weekday and hour, from our own GPS
-- data. Exported later as Valhalla historical traffic.
create table public.segment_speeds (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  osm_way_id bigint not null,
  forward boolean not null,
  -- ISO weekday, 1 = Monday ... 7 = Sunday, in the tenant's time zone.
  weekday smallint not null check (weekday between 1 and 7),
  hour smallint not null check (hour between 0 and 23),
  sample_count integer not null check (sample_count > 0),
  mean_speed_kmh numeric(5, 1) not null check (mean_speed_kmh >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, osm_way_id, forward, weekday, hour)
);
