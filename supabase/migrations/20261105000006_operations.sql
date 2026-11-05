-- Operations: planning and sending routes, driver progress and proof of
-- delivery, live positions and speed events from GPS uploads, the
-- BillZilla and KaiWorkforce integrations, and the nightly trip job.
--
-- People call the functions marked "app" in comments through Supabase RPC.
-- Functions marked "server" are executable by the service role only and are
-- called from webhooks and scheduled jobs.

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------

-- Latest known position per driver, for the live map when it first opens.
-- One row per driver, overwritten by each GPS upload. Live movement in
-- between uploads goes through Realtime Broadcast, not this table.
create table public.driver_positions (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  driver_id uuid not null,
  vehicle_id uuid,
  route_id uuid,
  recorded_at timestamptz not null,
  point extensions.geography(Point, 4326) not null,
  speed_kmh numeric(5, 1),
  heading_deg numeric(5, 1),
  accuracy_m numeric(6, 1),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, driver_id),
  foreign key (tenant_id, driver_id) references public.memberships (tenant_id, user_id),
  foreign key (vehicle_id, tenant_id) references public.vehicles (id, tenant_id),
  foreign key (route_id, tenant_id) references public.routes (id, tenant_id) on delete set null (route_id)
);

create type public.outbox_status as enum ('pending', 'sent', 'failed');

-- Messages Drivo owes another product (for now: delivery updates to
-- BillZilla). Written in the same transaction as the delivery, sent by the
-- server with retries.
create table public.integration_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null check (provider in ('billzilla')),
  event text not null,
  target_id text not null,
  payload jsonb not null,
  status public.outbox_status not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (id, tenant_id)
);
create index integration_outbox_due on public.integration_outbox (next_attempt_at) where status = 'pending';

-- Webhook deliveries already processed, so a retried webhook is ignored.
create table public.integration_deliveries (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null check (provider in ('billzilla', 'kaiworkforce')),
  delivery_id text not null check (char_length(delivery_id) between 1 and 200),
  event text not null,
  received_at timestamptz not null default now(),
  primary key (provider, delivery_id)
);
create index integration_deliveries_tenant on public.integration_deliveries (tenant_id, received_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['driver_positions', 'integration_outbox', 'integration_deliveries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format(
      'create policy "Managers read" on public.%I for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]))', t);
  end loop;
end
$$;
create policy "Drivers read their own position" on public.driver_positions
  for select to authenticated using (driver_id = (select auth.uid()) and tenant_id = any ((select app.driver_tenant_ids())::uuid[]));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The route row, locked, if the caller manages its tenant. Otherwise refuses.
create or replace function app.managed_route(p_route_id uuid)
returns public.routes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.routes;
begin
  select * into v from public.routes where id = p_route_id for update;
  if not found or not (v.tenant_id = any (app.manager_tenant_ids())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- The stop and its route, locked, if the caller is the route's driver.
create or replace function app.driven_stop(p_stop_id uuid, out stop public.route_stops, out route public.routes)
language plpgsql
security definer
set search_path = ''
as $$
begin
  select * into stop from public.route_stops where id = p_stop_id for update;
  if found then
    select * into route from public.routes where id = stop.route_id for update;
  end if;
  if stop.id is null or route.driver_id is distinct from auth.uid()
     or not (route.tenant_id = any (app.driver_tenant_ids())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Plan: save a draft route with its stops (app; Owner, Admin, Dispatcher).
--
-- p_route: { id?, name, route_date, depot_id, optimise_for, departure_at,
--   driver_id, vehicle_id, planned_distance_m, planned_duration_s,
--   fuel_estimate_l, geometry (GeoJSON LineString),
--   stops: [{ location_id, order_id?, planned_eta? }] in order }
-- ---------------------------------------------------------------------------
create or replace function public.save_route(p_tenant_id uuid, p_route jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_route ->> 'id', '')::uuid;
  v_route public.routes;
  v_stop jsonb;
  v_seq integer := 0;
  v_order uuid;
  v_geom extensions.geography;
  v_old_orders uuid[];
  v_new_orders uuid[];
begin
  if not (p_tenant_id = any (app.manager_tenant_ids())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_route -> 'stops') is distinct from 'array' then
    raise exception 'A route needs a list of stops' using errcode = '22023';
  end if;
  if p_route ? 'geometry' and jsonb_typeof(p_route -> 'geometry') = 'object' then
    v_geom := extensions.st_setsrid(extensions.st_geomfromgeojson((p_route -> 'geometry')::text), 4326)::extensions.geography;
  end if;

  select coalesce(array_agg((s ->> 'order_id')::uuid), '{}') into v_new_orders
  from jsonb_array_elements(p_route -> 'stops') s where nullif(s ->> 'order_id', '') is not null;

  if v_id is not null then
    v_route := app.managed_route(v_id);
    if v_route.tenant_id <> p_tenant_id or v_route.status <> 'draft' then
      raise exception 'Only draft routes can be changed' using errcode = '22023';
    end if;
    select coalesce(array_agg(order_id), '{}') into v_old_orders
    from public.route_stops where route_id = v_id and order_id is not null;
    update public.routes set
      name = nullif(trim(p_route ->> 'name'), ''),
      route_date = (p_route ->> 'route_date')::date,
      depot_id = (p_route ->> 'depot_id')::uuid,
      optimise_for = coalesce((p_route ->> 'optimise_for')::public.optimise_for, optimise_for),
      departure_at = (p_route ->> 'departure_at')::timestamptz,
      driver_id = nullif(p_route ->> 'driver_id', '')::uuid,
      vehicle_id = nullif(p_route ->> 'vehicle_id', '')::uuid,
      planned_distance_m = (p_route ->> 'planned_distance_m')::numeric::integer,
      planned_duration_s = (p_route ->> 'planned_duration_s')::numeric::integer,
      fuel_estimate_l = (p_route ->> 'fuel_estimate_l')::numeric,
      geometry = v_geom
    where id = v_id;
    delete from public.route_stops where route_id = v_id;
  else
    v_old_orders := '{}';
    insert into public.routes (
      tenant_id, name, route_date, depot_id, optimise_for, departure_at, driver_id, vehicle_id,
      planned_distance_m, planned_duration_s, fuel_estimate_l, geometry, created_by
    ) values (
      p_tenant_id, nullif(trim(p_route ->> 'name'), ''), (p_route ->> 'route_date')::date, (p_route ->> 'depot_id')::uuid,
      coalesce((p_route ->> 'optimise_for')::public.optimise_for, 'lowest_fuel'),
      (p_route ->> 'departure_at')::timestamptz,
      nullif(p_route ->> 'driver_id', '')::uuid, nullif(p_route ->> 'vehicle_id', '')::uuid,
      (p_route ->> 'planned_distance_m')::numeric::integer, (p_route ->> 'planned_duration_s')::numeric::integer,
      (p_route ->> 'fuel_estimate_l')::numeric, v_geom, auth.uid()
    ) returning id into v_id;
  end if;

  -- Drivers must be active drivers of this tenant.
  if exists (
    select 1 from public.routes r where r.id = v_id and r.driver_id is not null and not exists (
      select 1 from public.memberships m
      where m.tenant_id = r.tenant_id and m.user_id = r.driver_id and m.role = 'driver' and m.active
    )
  ) then
    raise exception 'The assigned driver is not an active driver' using errcode = '22023';
  end if;

  for v_stop in select * from jsonb_array_elements(p_route -> 'stops') loop
    v_seq := v_seq + 1;
    v_order := nullif(v_stop ->> 'order_id', '')::uuid;
    if v_order is not null then
      if exists (
        select 1 from public.route_stops s join public.routes r on r.id = s.route_id
        where s.order_id = v_order and r.id <> v_id and r.status in ('draft', 'sent', 'in_progress')
      ) then
        raise exception 'An order is already on another route' using errcode = '22023';
      end if;
      if exists (select 1 from public.orders o where o.id = v_order and o.delivery_status not in ('ready', 'planned', 'failed')) then
        raise exception 'An order is not ready for delivery' using errcode = '22023';
      end if;
    end if;
    insert into public.route_stops (tenant_id, route_id, sequence, location_id, order_id, planned_eta)
    values (p_tenant_id, v_id, v_seq, (v_stop ->> 'location_id')::uuid, v_order, (v_stop ->> 'planned_eta')::timestamptz);
  end loop;

  update public.orders set delivery_status = 'ready'
    where id = any (v_old_orders) and not (id = any (v_new_orders)) and delivery_status = 'planned';
  update public.orders set delivery_status = 'planned'
    where id = any (v_new_orders) and delivery_status in ('ready', 'failed');
  return v_id;
end;
$$;

-- Send a draft to its driver (app; managers).
create or replace function public.send_route(p_route_id uuid)
returns public.routes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.routes := app.managed_route(p_route_id);
begin
  if v.status <> 'draft' then
    raise exception 'Only a draft can be sent' using errcode = '22023';
  end if;
  if v.driver_id is null or v.vehicle_id is null then
    raise exception 'Choose a driver and a vehicle before sending' using errcode = '22023';
  end if;
  if not exists (select 1 from public.route_stops where route_id = p_route_id) then
    raise exception 'The route has no stops' using errcode = '22023';
  end if;
  update public.routes set status = 'sent', sent_at = now() where id = p_route_id returning * into v;
  return v;
end;
$$;

-- Cancel a route (app; managers). Undelivered orders go back to ready.
create or replace function public.cancel_route(p_route_id uuid)
returns public.routes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.routes := app.managed_route(p_route_id);
begin
  if v.status in ('completed', 'cancelled') then
    raise exception 'This route is already %', v.status using errcode = '22023';
  end if;
  update public.orders set delivery_status = 'ready'
    where id in (
      select order_id from public.route_stops
      where route_id = p_route_id and order_id is not null and status in ('scheduled', 'arrived')
    );
  update public.route_stops set status = 'skipped' where route_id = p_route_id and status in ('scheduled', 'arrived');
  update public.routes set status = 'cancelled', cancelled_at = now() where id = p_route_id returning * into v;
  update public.shifts set ended_at = now() where route_id = p_route_id and source = 'route' and ended_at is null;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Driver progress (app; the route's driver)
-- ---------------------------------------------------------------------------

-- Start a sent route. For tenants without KaiWorkforce this also starts
-- tracking (opens a route shift). Returns the route and the open shift.
create or replace function public.start_route(p_route_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.routes;
  v_shift uuid;
  v_kw boolean;
begin
  select * into v from public.routes where id = p_route_id for update;
  if not found or v.driver_id is distinct from auth.uid() or not (v.tenant_id = any (app.driver_tenant_ids())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if v.status = 'sent' then
    update public.routes set status = 'in_progress', started_at = now() where id = p_route_id returning * into v;
    update public.orders set delivery_status = 'out_for_delivery'
      where id in (select order_id from public.route_stops where route_id = p_route_id and order_id is not null)
        and delivery_status = 'planned';
  elsif v.status <> 'in_progress' then
    raise exception 'This route cannot be started' using errcode = '22023';
  end if;

  select id into v_shift from public.shifts where tenant_id = v.tenant_id and driver_id = v.driver_id and ended_at is null;
  select kaiworkforce_enabled into v_kw from public.tenants where id = v.tenant_id;
  if v_shift is null and not v_kw then
    insert into public.shifts (tenant_id, driver_id, source, route_id, started_at)
    values (v.tenant_id, v.driver_id, 'route', v.id, now())
    returning id into v_shift;
  end if;
  return jsonb_build_object('route_id', v.id, 'status', v.status, 'shift_id', v_shift, 'tracking', v_shift is not null);
end;
$$;

-- Mark arrival at a stop. Returns how far the driver is from the pin.
create or replace function public.arrive_stop(p_stop_id uuid, p_lon double precision default null, p_lat double precision default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_distance double precision;
begin
  select * into r from app.driven_stop(p_stop_id);
  if (r.route).status <> 'in_progress' then
    raise exception 'Start the route first' using errcode = '22023';
  end if;
  if (r.stop).status = 'scheduled' then
    update public.route_stops set status = 'arrived', arrived_at = now() where id = p_stop_id;
  end if;
  if p_lon is not null then
    select extensions.st_distance(l.point, app.make_point(p_lon, p_lat)) into v_distance
    from public.locations l where l.id = (r.stop).location_id;
  end if;
  return jsonb_build_object('stop_id', p_stop_id, 'status', 'arrived', 'distance_m', round(v_distance::numeric, 1));
end;
$$;

-- Complete a stop with proof of delivery. Safe to call again with the same
-- proof (the phone retries when signal returns): the first call wins.
--
-- p_proof: { id, outcome: delivered | partially_delivered | failed,
--   received_by, partial_notes, photo_path, signature_path, lon, lat,
--   accuracy_m, captured_at }
create or replace function public.complete_stop(p_stop_id uuid, p_proof jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_outcome public.stop_status := (p_proof ->> 'outcome')::public.stop_status;
  v_order public.orders;
  v_point extensions.geography;
  v_route_status public.route_status;
  v_driver text;
  v_plate text;
  v_captured timestamptz := coalesce((p_proof ->> 'captured_at')::timestamptz, now());
begin
  select * into r from app.driven_stop(p_stop_id);

  if exists (select 1 from public.proofs_of_delivery where stop_id = p_stop_id) then
    select status into v_route_status from public.routes where id = (r.route).id;
    return jsonb_build_object('stop_id', p_stop_id, 'status', (r.stop).status, 'route_status', v_route_status, 'duplicate', true);
  end if;
  if (r.route).status <> 'in_progress' then
    raise exception 'Start the route first' using errcode = '22023';
  end if;
  if v_outcome not in ('delivered', 'partially_delivered', 'failed') then
    raise exception 'Outcome must be delivered, partially_delivered or failed' using errcode = '22023';
  end if;
  if v_outcome <> 'delivered' and char_length(trim(coalesce(p_proof ->> 'partial_notes', ''))) = 0 then
    raise exception 'Say what happened' using errcode = '22023';
  end if;
  if v_outcome <> 'failed' and char_length(trim(coalesce(p_proof ->> 'received_by', ''))) = 0 then
    raise exception 'Enter who received the goods' using errcode = '22023';
  end if;
  if p_proof ? 'lon' and p_proof ->> 'lon' is not null then
    v_point := app.make_point((p_proof ->> 'lon')::double precision, (p_proof ->> 'lat')::double precision);
  end if;

  insert into public.proofs_of_delivery (
    id, tenant_id, stop_id, photo_path, signature_path, received_by, delivered_in_full, partial_notes,
    captured_by, captured_at, point, accuracy_m
  ) values (
    coalesce(nullif(p_proof ->> 'id', '')::uuid, gen_random_uuid()), (r.stop).tenant_id, p_stop_id,
    nullif(p_proof ->> 'photo_path', ''), nullif(p_proof ->> 'signature_path', ''),
    nullif(trim(p_proof ->> 'received_by'), ''), v_outcome = 'delivered', nullif(trim(p_proof ->> 'partial_notes'), ''),
    auth.uid(), v_captured, v_point, (p_proof ->> 'accuracy_m')::numeric
  );

  update public.route_stops set
    status = v_outcome,
    arrived_at = coalesce(arrived_at, v_captured),
    completed_at = v_captured,
    failure_reason = case when v_outcome = 'failed' then nullif(trim(p_proof ->> 'partial_notes'), '') end
  where id = p_stop_id;

  if (r.stop).order_id is not null then
    update public.orders set
      delivery_status = v_outcome::text::public.delivery_status,
      delivered_at = case when v_outcome = 'failed' then null else v_captured end
    where id = (r.stop).order_id
    returning * into v_order;

    if v_order.source = 'billzilla' then
      select m.full_name into v_driver from public.memberships m where m.tenant_id = v_order.tenant_id and m.user_id = auth.uid();
      select v.plate into v_plate from public.vehicles v where v.id = (r.route).vehicle_id;
      insert into public.integration_outbox (tenant_id, provider, event, target_id, payload)
      values (v_order.tenant_id, 'billzilla', 'delivery.updated', v_order.billzilla_invoice_id, jsonb_build_object(
        'invoice_id', v_order.billzilla_invoice_id,
        'status', v_outcome,
        'delivered_at', case when v_outcome = 'failed' then null else v_captured end,
        'received_by', nullif(trim(p_proof ->> 'received_by'), ''),
        'delivered_in_full', v_outcome = 'delivered',
        'notes', nullif(trim(p_proof ->> 'partial_notes'), ''),
        'driver_name', v_driver,
        'vehicle_plate', v_plate,
        'photo_path', nullif(p_proof ->> 'photo_path', ''),
        'signature_path', nullif(p_proof ->> 'signature_path', '')
      ));
    end if;
  end if;

  -- Finish the route when no stop is left to do.
  if not exists (select 1 from public.route_stops where route_id = (r.route).id and status in ('scheduled', 'arrived')) then
    update public.routes set status = 'completed', completed_at = now() where id = (r.route).id;
    update public.shifts set ended_at = now() where route_id = (r.route).id and source = 'route' and ended_at is null;
  end if;
  select status into v_route_status from public.routes where id = (r.route).id;
  return jsonb_build_object('stop_id', p_stop_id, 'status', v_outcome, 'route_status', v_route_status, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- GPS uploads: keep the latest position and record speed events.
-- A speed event is a run of points over the limit (plus tolerance) lasting
-- at least the tenant's speed_alert_after_s. Runs are judged per upload.
-- ---------------------------------------------------------------------------
create or replace function app.gps_batches_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.tenant_settings;
  p jsonb;
  v_last jsonb;
  v_route public.routes;
  v_at timestamptz;
  v_point extensions.geography;
  v_speed numeric;
  v_limit integer;
  v_zone text;
  run_start timestamptz;
  run_end timestamptz;
  run_max numeric;
  run_limit integer;
  run_zone text;
  run_point extensions.geography;
begin
  select * into s from public.tenant_settings where tenant_id = new.tenant_id;
  select * into v_route from public.routes r
    where r.tenant_id = new.tenant_id and r.driver_id = new.driver_id and r.status = 'in_progress'
    order by r.started_at desc limit 1;

  for p in
    select e from jsonb_array_elements(new.points) e
    where jsonb_typeof(e) = 'array' and jsonb_array_length(e) >= 3
    order by (e ->> 0)::bigint
  loop
    v_at := to_timestamp((p ->> 0)::bigint / 1000.0);
    v_point := app.make_point((p ->> 1)::double precision, (p ->> 2)::double precision);
    v_speed := round(coalesce((p ->> 4)::numeric, 0) * 3.6, 1);
    v_last := p;
    select l.limit_kmh, l.zone_name into v_limit, v_zone from app.speed_limit_at(new.tenant_id, v_point) l;

    if v_speed > v_limit + s.speed_tolerance_kmh then
      if run_start is null then
        run_start := v_at; run_max := v_speed; run_limit := v_limit; run_zone := v_zone; run_point := v_point;
      end if;
      run_end := v_at;
      if v_speed > run_max then
        run_max := v_speed; run_point := v_point;
      end if;
      run_limit := least(run_limit, v_limit);
    elsif run_start is not null then
      run_end := v_at;
      if extract(epoch from run_end - run_start) >= s.speed_alert_after_s then
        insert into public.speed_events (tenant_id, driver_id, vehicle_id, route_id, started_at, duration_s, max_speed_kmh, limit_kmh, zone_name, point)
        values (new.tenant_id, new.driver_id, coalesce(new.vehicle_id, v_route.vehicle_id), v_route.id, run_start,
          extract(epoch from run_end - run_start)::integer, run_max, run_limit, run_zone, run_point);
      end if;
      run_start := null;
    end if;
  end loop;
  if run_start is not null and extract(epoch from run_end - run_start) >= s.speed_alert_after_s then
    insert into public.speed_events (tenant_id, driver_id, vehicle_id, route_id, started_at, duration_s, max_speed_kmh, limit_kmh, zone_name, point)
    values (new.tenant_id, new.driver_id, coalesce(new.vehicle_id, v_route.vehicle_id), v_route.id, run_start,
      extract(epoch from run_end - run_start)::integer, run_max, run_limit, run_zone, run_point);
  end if;

  if v_last is not null then
    insert into public.driver_positions (tenant_id, driver_id, vehicle_id, route_id, recorded_at, point, speed_kmh, heading_deg, accuracy_m, updated_at)
    values (
      new.tenant_id, new.driver_id, coalesce(new.vehicle_id, v_route.vehicle_id), v_route.id,
      to_timestamp((v_last ->> 0)::bigint / 1000.0),
      app.make_point((v_last ->> 1)::double precision, (v_last ->> 2)::double precision),
      round(coalesce((v_last ->> 4)::numeric, 0) * 3.6, 1), (v_last ->> 5)::numeric, (v_last ->> 3)::numeric, now()
    )
    on conflict (tenant_id, driver_id) do update set
      vehicle_id = excluded.vehicle_id, route_id = excluded.route_id, recorded_at = excluded.recorded_at,
      point = excluded.point, speed_kmh = excluded.speed_kmh, heading_deg = excluded.heading_deg,
      accuracy_m = excluded.accuracy_m, updated_at = now()
    where public.driver_positions.recorded_at <= excluded.recorded_at;
  end if;
  return new;
end;
$$;
create trigger gps_batches_after_insert after insert on public.gps_batches
  for each row execute function app.gps_batches_after_insert();

-- ---------------------------------------------------------------------------
-- KaiWorkforce clock-in and clock-out (server).
-- ---------------------------------------------------------------------------
create or replace function public.kaiworkforce_clock(
  p_company_id text,
  p_employee_id text,
  p_event text,
  p_shift_id text,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_driver uuid;
  v_shift uuid;
begin
  select t.id into v_tenant from public.tenants t
    where t.kaiworkforce_company_id = p_company_id and t.kaiworkforce_enabled and t.status = 'active';
  if v_tenant is null then
    return jsonb_build_object('result', 'ignored', 'reason', 'unknown company');
  end if;
  select m.user_id into v_driver from public.memberships m
    where m.tenant_id = v_tenant and m.kaiworkforce_employee_id = p_employee_id and m.role = 'driver' and m.active;
  if v_driver is null then
    return jsonb_build_object('result', 'ignored', 'reason', 'not a Drivo driver', 'tenant_id', v_tenant);
  end if;

  if p_event = 'shift.clock_in' then
    select id into v_shift from public.shifts where tenant_id = v_tenant and driver_id = v_driver and ended_at is null;
    if v_shift is null then
      insert into public.shifts (tenant_id, driver_id, source, kaiworkforce_shift_id, started_at)
      values (v_tenant, v_driver, 'kaiworkforce', p_shift_id, coalesce(p_at, now()))
      returning id into v_shift;
      return jsonb_build_object('result', 'opened', 'tenant_id', v_tenant, 'driver_id', v_driver, 'shift_id', v_shift);
    end if;
    return jsonb_build_object('result', 'already_open', 'tenant_id', v_tenant, 'driver_id', v_driver, 'shift_id', v_shift);
  elsif p_event = 'shift.clock_out' then
    update public.shifts set ended_at = greatest(coalesce(p_at, now()), started_at)
      where tenant_id = v_tenant and driver_id = v_driver and ended_at is null
      returning id into v_shift;
    return jsonb_build_object('result', case when v_shift is null then 'no_open_shift' else 'closed' end,
      'tenant_id', v_tenant, 'driver_id', v_driver, 'shift_id', v_shift);
  end if;
  raise exception 'Unknown event %', p_event using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- BillZilla webhooks and sync (server). Upserts customers and invoices.
-- ---------------------------------------------------------------------------
create or replace function public.billzilla_ingest(p_organisation_id text, p_event text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_inv jsonb := p_payload -> 'invoice';
  v_cust jsonb := coalesce(p_payload -> 'customer', p_payload -> 'invoice' -> 'customer');
  v_customer uuid;
  v_order public.orders;
  v_in_progress boolean := false;
begin
  select t.id into v_tenant from public.tenants t
    where t.billzilla_org_id = p_organisation_id and t.billzilla_enabled and t.status = 'active';
  if v_tenant is null then
    raise exception 'Unknown BillZilla organisation' using errcode = '22023';
  end if;

  if v_cust is not null and v_cust ? 'id' then
    insert into public.customers (tenant_id, source, billzilla_customer_id, name, phone, address)
    values (v_tenant, 'billzilla', v_cust ->> 'id', v_cust ->> 'name', v_cust ->> 'phone', v_cust ->> 'address')
    on conflict (tenant_id, billzilla_customer_id) do update set
      name = coalesce(excluded.name, public.customers.name),
      phone = excluded.phone,
      address = excluded.address
    returning id into v_customer;
  end if;

  if p_event = 'invoice.confirmed' then
    insert into public.orders (
      tenant_id, source, billzilla_invoice_id, reference, customer_id, customer_name, cartons, line_items,
      total_amount, currency, billzilla_status, confirmed_at
    ) values (
      v_tenant, 'billzilla', v_inv ->> 'id', coalesce(v_inv ->> 'number', v_inv ->> 'id'), v_customer, v_cust ->> 'name',
      coalesce((v_inv ->> 'cartons')::integer, 0), coalesce(v_inv -> 'lines', '[]'::jsonb),
      (v_inv ->> 'total')::numeric, coalesce(v_inv ->> 'currency', 'FJD'), coalesce(v_inv ->> 'status', 'confirmed'),
      (v_inv ->> 'confirmed_at')::timestamptz
    )
    on conflict (tenant_id, billzilla_invoice_id) do update set
      reference = excluded.reference,
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      cartons = excluded.cartons,
      line_items = excluded.line_items,
      total_amount = excluded.total_amount,
      currency = excluded.currency,
      billzilla_status = excluded.billzilla_status,
      confirmed_at = excluded.confirmed_at,
      delivery_status = case when public.orders.delivery_status = 'cancelled' then 'ready' else public.orders.delivery_status end
    returning * into v_order;
    return jsonb_build_object('result', 'stored', 'tenant_id', v_tenant, 'order_id', v_order.id);

  elsif p_event = 'invoice.cancelled' then
    select * into v_order from public.orders where tenant_id = v_tenant and billzilla_invoice_id = v_inv ->> 'id' for update;
    if not found then
      return jsonb_build_object('result', 'ignored', 'reason', 'unknown invoice', 'tenant_id', v_tenant);
    end if;
    if v_order.delivery_status in ('delivered', 'partially_delivered') then
      return jsonb_build_object('result', 'ignored', 'reason', 'already delivered', 'tenant_id', v_tenant, 'order_id', v_order.id);
    end if;
    select exists (
      select 1 from public.route_stops s join public.routes r on r.id = s.route_id
      where s.order_id = v_order.id and r.status = 'in_progress' and s.status in ('scheduled', 'arrived')
    ) into v_in_progress;
    -- Take it off routes that have not started; keep it on a route in
    -- progress so the dispatcher can tell the driver.
    delete from public.route_stops s using public.routes r
      where r.id = s.route_id and s.order_id = v_order.id and r.status in ('draft', 'sent');
    update public.orders set delivery_status = 'cancelled', billzilla_status = 'cancelled' where id = v_order.id;
    return jsonb_build_object('result', 'cancelled', 'tenant_id', v_tenant, 'order_id', v_order.id, 'on_route_in_progress', v_in_progress);

  elsif p_event = 'customer.updated' then
    return jsonb_build_object('result', 'stored', 'tenant_id', v_tenant, 'customer_id', v_customer);
  end if;
  raise exception 'Unknown event %', p_event using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- Nightly job (server): compress a driver's day into one trips row.
-- The job first archives the raw points to R2, then calls this with the
-- archive path (and, when available, the road-snapped line from Valhalla).
-- The day's GPS batches are deleted afterwards.
-- ---------------------------------------------------------------------------
create or replace function public.finish_trip(
  p_tenant_id uuid,
  p_driver_id uuid,
  p_trip_date date,
  p_archive_path text,
  p_matched_line jsonb default null
)
returns public.trips
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_trip public.trips;
  v_line extensions.geometry;
  v_distance integer;
  v_duration integer;
  v_moving integer;
  v_idle integer;
  v_max numeric;
  v_count integer;
begin
  select time_zone into v_tz from public.tenants where id = p_tenant_id;
  v_from := (p_trip_date::timestamp) at time zone v_tz;
  v_to := ((p_trip_date + 1)::timestamp) at time zone v_tz;

  with pts as (
    select
      to_timestamp((e ->> 0)::bigint / 1000.0) as at,
      extensions.st_setsrid(extensions.st_makepoint((e ->> 1)::double precision, (e ->> 2)::double precision), 4326) as g,
      coalesce((e ->> 4)::numeric, 0) as mps
    from public.gps_batches b, jsonb_array_elements(b.points) e
    where b.tenant_id = p_tenant_id and b.driver_id = p_driver_id
      and b.recorded_from < v_to and b.recorded_to >= v_from
      and jsonb_typeof(e) = 'array'
  ),
  day as (
    select distinct on (at) * from pts where at >= v_from and at < v_to order by at
  ),
  steps as (
    select at, g, mps,
      least(coalesce(extract(epoch from at - lag(at) over (order by at)), 0), 120) as dt,
      extensions.st_distance(g::extensions.geography, (lag(g) over (order by at))::extensions.geography) as dm
    from day
  )
  select
    coalesce(sum(dm), 0)::integer,
    coalesce(extract(epoch from max(at) - min(at)), 0)::integer,
    coalesce(sum(dt) filter (where mps >= 1), 0)::integer,
    coalesce(sum(dt) filter (where mps < 1), 0)::integer,
    round(max(mps) * 3.6, 1),
    count(*)::integer,
    -- Shift longitudes to 0..360 so a day around Taveuni or the Lau Group
    -- simplifies as one line rather than splitting at the 180 degree meridian.
    case when count(*) >= 2 then extensions.st_simplify(extensions.st_shiftlongitude(extensions.st_makeline(g order by at)), 0.00005) end
  into v_distance, v_duration, v_moving, v_idle, v_max, v_count, v_line
  from steps;

  if p_matched_line is not null then
    v_line := extensions.st_simplify(extensions.st_shiftlongitude(
      extensions.st_setsrid(extensions.st_geomfromgeojson(p_matched_line::text), 4326)), 0.00005);
  end if;

  insert into public.trips (tenant_id, driver_id, vehicle_id, trip_date, geometry, distance_m, duration_s, moving_s, idle_s,
    max_speed_kmh, point_count, raw_archive_path)
  values (
    p_tenant_id, p_driver_id,
    (select r.vehicle_id from public.routes r where r.tenant_id = p_tenant_id and r.driver_id = p_driver_id and r.route_date = p_trip_date
       and r.vehicle_id is not null order by r.started_at nulls last limit 1),
    p_trip_date, v_line::extensions.geography, coalesce(v_distance, 0), coalesce(v_duration, 0),
    coalesce(v_moving, 0), coalesce(v_idle, 0), v_max, coalesce(v_count, 0), p_archive_path
  )
  on conflict (tenant_id, driver_id, trip_date) do update set
    geometry = excluded.geometry, distance_m = excluded.distance_m, duration_s = excluded.duration_s,
    moving_s = excluded.moving_s, idle_s = excluded.idle_s, max_speed_kmh = excluded.max_speed_kmh,
    point_count = excluded.point_count, raw_archive_path = excluded.raw_archive_path, vehicle_id = excluded.vehicle_id
  returning * into v_trip;

  delete from public.gps_batches
    where tenant_id = p_tenant_id and driver_id = p_driver_id and recorded_to < v_to and recorded_from >= v_from;
  return v_trip;
end;
$$;

-- Driver days with points waiting to be compressed (server), in each
-- tenant's time zone, before the given date.
create or replace function public.pending_trip_days(p_before date)
returns table (tenant_id uuid, driver_id uuid, trip_date date)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct b.tenant_id, b.driver_id, (b.recorded_from at time zone t.time_zone)::date
  from public.gps_batches b join public.tenants t on t.id = b.tenant_id
  where (b.recorded_from at time zone t.time_zone)::date < p_before
  order by 1, 2, 3
$$;

-- Merge hourly average speeds per road segment (server).
-- p_rows: [{ osm_way_id, forward, weekday, hour, samples, mean_speed_kmh }]
create or replace function public.add_segment_speeds(p_tenant_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.segment_speeds as s (tenant_id, osm_way_id, forward, weekday, hour, sample_count, mean_speed_kmh, updated_at)
  select p_tenant_id, (r ->> 'osm_way_id')::bigint, (r ->> 'forward')::boolean, (r ->> 'weekday')::smallint,
    (r ->> 'hour')::smallint, (r ->> 'samples')::integer, (r ->> 'mean_speed_kmh')::numeric, now()
  from jsonb_array_elements(p_rows) r
  where (r ->> 'samples')::integer > 0
  on conflict (tenant_id, osm_way_id, forward, weekday, hour) do update set
    mean_speed_kmh = round(
      (s.mean_speed_kmh * s.sample_count + excluded.mean_speed_kmh * excluded.sample_count)
      / (s.sample_count + excluded.sample_count), 1),
    sample_count = s.sample_count + excluded.sample_count,
    updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function app.managed_route(uuid), app.driven_stop(uuid), app.gps_batches_after_insert() from public;
grant execute on function app.managed_route(uuid), app.driven_stop(uuid) to authenticated, service_role;

revoke all on function
  public.save_route(uuid, jsonb), public.send_route(uuid), public.cancel_route(uuid),
  public.start_route(uuid), public.arrive_stop(uuid, double precision, double precision), public.complete_stop(uuid, jsonb)
  from public, anon;
grant execute on function
  public.save_route(uuid, jsonb), public.send_route(uuid), public.cancel_route(uuid),
  public.start_route(uuid), public.arrive_stop(uuid, double precision, double precision), public.complete_stop(uuid, jsonb)
  to authenticated, service_role;

revoke all on function
  public.kaiworkforce_clock(text, text, text, text, timestamptz),
  public.billzilla_ingest(text, text, jsonb),
  public.finish_trip(uuid, uuid, date, text, jsonb),
  public.pending_trip_days(date),
  public.add_segment_speeds(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.kaiworkforce_clock(text, text, text, text, timestamptz),
  public.billzilla_ingest(text, text, jsonb),
  public.finish_trip(uuid, uuid, date, text, jsonb),
  public.pending_trip_days(date),
  public.add_segment_speeds(uuid, jsonb)
  to service_role;

-- Live positions and alerts reach the admin map through Realtime.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.speed_events, public.driver_positions, public.route_stops;
  end if;
end
$$;
