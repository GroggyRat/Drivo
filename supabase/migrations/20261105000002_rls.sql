-- Row Level Security.
--
-- Every policy goes through the helpers below, and every helper goes
-- through app.active_memberships(). That one function checks the person's
-- membership is active and the tenant is not suspended, so suspension and
-- deactivation are enforced in one place. New access checks must use these
-- helpers.
--
-- Roles:
--   owner, admin   everything in their tenant, including settings,
--                  vehicles, people and approving locations
--   dispatcher     plan and assign routes, live map, review locations
--   driver         own routes, approved locations and own pins, own GPS

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function app.active_memberships()
returns table (tenant_id uuid, role public.member_role)
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id, m.role
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid() and m.active and t.status = 'active'
$$;

-- The caller's role in a tenant, or null.
create or replace function app.member_role(p_tenant_id uuid)
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select am.role from app.active_memberships() am where am.tenant_id = p_tenant_id
$$;

-- Tenant id lists for policies. Policies wrap them in (select ...) so they
-- run once per query, not once per row.
create or replace function app.member_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(am.tenant_id), '{}') from app.active_memberships() am
$$;

create or replace function app.manager_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(am.tenant_id), '{}') from app.active_memberships() am
  where am.role in ('owner', 'admin', 'dispatcher')
$$;

create or replace function app.admin_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(am.tenant_id), '{}') from app.active_memberships() am
  where am.role in ('owner', 'admin')
$$;

create or replace function app.driver_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(am.tenant_id), '{}') from app.active_memberships() am
  where am.role = 'driver'
$$;

-- Routes the caller drives that have been sent to them. Drafts stay hidden
-- from drivers until a dispatcher sends them.
create or replace function app.my_route_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(r.id), '{}')
  from public.routes r
  where r.driver_id = auth.uid()
    and r.status in ('sent', 'in_progress', 'completed')
    and r.tenant_id = any (app.driver_tenant_ids())
$$;

create or replace function app.my_order_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct s.order_id), '{}')
  from public.route_stops s
  where s.route_id = any (app.my_route_ids()) and s.order_id is not null
$$;

create or replace function app.my_customer_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct o.customer_id), '{}')
  from public.orders o
  where o.id = any (app.my_order_ids())
$$;

create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid())
$$;

revoke all on all functions in schema app from public;
grant execute on function
  app.active_memberships(), app.member_role(uuid), app.member_tenant_ids(), app.manager_tenant_ids(),
  app.admin_tenant_ids(), app.driver_tenant_ids(), app.my_route_ids(), app.my_order_ids(),
  app.my_customer_ids(), app.is_platform_admin()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Lock everything down first, then grant what each role needs.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'tenants', 'platform_admins', 'memberships', 'tenant_settings', 'speed_zones', 'depots',
    'locations', 'customers', 'vehicles', 'orders', 'routes', 'route_stops', 'proofs_of_delivery',
    'shifts', 'gps_batches', 'trips', 'speed_events', 'segment_speeds'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Tenants and platform admins
-- ---------------------------------------------------------------------------
create policy "Members read their tenants" on public.tenants
  for select to authenticated using (id = any ((select app.member_tenant_ids())::uuid[]));

-- Admins edit their tenant's details. Status, slug and the external ids that
-- webhooks use are platform-only.
grant update (name, time_zone, contact_email, logo_path, billzilla_enabled, kaiworkforce_enabled)
  on public.tenants to authenticated;
create policy "Admins update their tenant" on public.tenants
  for update to authenticated
  using (id = any ((select app.admin_tenant_ids())::uuid[]))
  with check (id = any ((select app.admin_tenant_ids())::uuid[]));

create policy "Platform admins read their own row" on public.platform_admins
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Memberships. Accounts are created by the server (service role), because
-- that also creates the sign-in account. Admins change roles and deactivate.
-- ---------------------------------------------------------------------------
create policy "Managers read their tenant's people; others read their own row" on public.memberships
  for select to authenticated using (
    tenant_id = any ((select app.manager_tenant_ids())::uuid[])
    or (user_id = (select auth.uid()) and tenant_id = any ((select app.member_tenant_ids())::uuid[]))
  );

grant update (role, full_name, email, phone, kaiworkforce_employee_id, active) on public.memberships to authenticated;
create policy "Admins update their tenant's people" on public.memberships
  for update to authenticated
  using (tenant_id = any ((select app.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select app.admin_tenant_ids())::uuid[]));

-- Only the Owner can change the Owner's row or make someone Owner, and
-- nobody can change their own role or deactivate themselves.
create or replace function app.memberships_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only requests from signed-in people are checked; the server (service
  -- role), migrations and seed data are not.
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  if (old.role = 'owner' or new.role = 'owner') and app.member_role(old.tenant_id) is distinct from 'owner' then
    raise exception 'Only the Owner can change the Owner' using errcode = '42501';
  end if;
  if old.user_id = auth.uid() and (new.role <> old.role or new.active <> old.active) then
    raise exception 'You cannot change your own role or access' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger memberships_guard before update on public.memberships
  for each row execute function app.memberships_guard();

-- ---------------------------------------------------------------------------
-- Settings, speed zones, depots, vehicles: everyone in the tenant reads
-- (drivers need limits, depots and their vehicle); Owners and Admins write.
-- ---------------------------------------------------------------------------
create policy "Members read settings" on public.tenant_settings
  for select to authenticated using (tenant_id = any ((select app.member_tenant_ids())::uuid[]));
grant update (urban_speed_limit_kmh, highway_speed_limit_kmh, speed_alert_after_s, speed_tolerance_kmh,
  fuel_price_per_l, idle_fuel_l_per_stop, currency, arrival_radius_m, duplicate_radius_m)
  on public.tenant_settings to authenticated;
create policy "Admins update settings" on public.tenant_settings
  for update to authenticated
  using (tenant_id = any ((select app.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select app.admin_tenant_ids())::uuid[]));

do $$
declare
  t text;
begin
  foreach t in array array['speed_zones', 'depots', 'vehicles'] loop
    execute format('grant insert, update, delete on public.%I to authenticated', t);
    execute format(
      'create policy "Members read" on public.%I for select to authenticated using (tenant_id = any ((select app.member_tenant_ids())::uuid[]))', t);
    execute format(
      'create policy "Admins insert" on public.%I for insert to authenticated with check (tenant_id = any ((select app.admin_tenant_ids())::uuid[]))', t);
    execute format(
      'create policy "Admins update" on public.%I for update to authenticated using (tenant_id = any ((select app.admin_tenant_ids())::uuid[])) with check (tenant_id = any ((select app.admin_tenant_ids())::uuid[]))', t);
    execute format(
      'create policy "Admins delete" on public.%I for delete to authenticated using (tenant_id = any ((select app.admin_tenant_ids())::uuid[]))', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Locations: read here, written only through the location functions.
-- Managers see everything. Drivers see approved locations (hiding expired
-- hazards) and their own pins.
-- ---------------------------------------------------------------------------
create policy "Managers read all locations" on public.locations
  for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Drivers read approved locations and their own pins" on public.locations
  for select to authenticated using (
    tenant_id = any ((select app.driver_tenant_ids())::uuid[])
    and (
      (status = 'approved' and (expires_at is null or expires_at > now()))
      or created_by = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Customers and orders. Managers read and write (manual and CSV orders).
-- BillZilla rows are written by the server from webhooks, so people cannot
-- create or edit them. Drivers read the ones on their routes.
-- ---------------------------------------------------------------------------
grant insert, update on public.customers, public.orders to authenticated;

create policy "Managers read customers" on public.customers
  for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Drivers read customers on their routes" on public.customers
  for select to authenticated using (id = any ((select app.my_customer_ids())::uuid[]));
create policy "Managers add customers" on public.customers
  for insert to authenticated
  with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]) and source <> 'billzilla');
create policy "Managers update customers" on public.customers
  for update to authenticated
  using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));

create policy "Managers read orders" on public.orders
  for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Drivers read orders on their routes" on public.orders
  for select to authenticated using (id = any ((select app.my_order_ids())::uuid[]));
create policy "Managers add orders" on public.orders
  for insert to authenticated
  with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]) and source <> 'billzilla');
create policy "Managers update their own orders" on public.orders
  for update to authenticated
  using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]) and source <> 'billzilla')
  with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]) and source <> 'billzilla');

-- Customers can be linked to a different location, but a BillZilla customer's
-- name, id and source come from BillZilla.
create or replace function app.customers_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only requests from signed-in people are checked; the server (service
  -- role), migrations and seed data are not.
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  if new.source is distinct from old.source
     or new.billzilla_customer_id is distinct from old.billzilla_customer_id
     or (old.source = 'billzilla' and (new.name is distinct from old.name or new.phone is distinct from old.phone)) then
    raise exception 'BillZilla customer details are changed in BillZilla' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger customers_guard before update on public.customers
  for each row execute function app.customers_guard();

-- ---------------------------------------------------------------------------
-- Routes and stops. Managers plan; drivers read routes sent to them.
-- Driver progress (arrive, complete) goes through functions added with the
-- driver app.
-- ---------------------------------------------------------------------------
grant insert, update, delete on public.routes, public.route_stops to authenticated;

create policy "Managers read routes" on public.routes
  for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Drivers read their sent routes" on public.routes
  for select to authenticated using (id = any ((select app.my_route_ids())::uuid[]));
create policy "Managers add routes" on public.routes
  for insert to authenticated with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Managers update routes" on public.routes
  for update to authenticated
  using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Managers delete draft routes" on public.routes
  for delete to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]) and status = 'draft');

create policy "Managers read stops" on public.route_stops
  for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Drivers read stops on their routes" on public.route_stops
  for select to authenticated using (route_id = any ((select app.my_route_ids())::uuid[]));
create policy "Managers add stops" on public.route_stops
  for insert to authenticated with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Managers update stops" on public.route_stops
  for update to authenticated
  using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Managers delete stops" on public.route_stops
  for delete to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));

-- ---------------------------------------------------------------------------
-- Proof of delivery: read only here; written by the complete-delivery
-- function with the driver app.
-- ---------------------------------------------------------------------------
create policy "Managers read proofs" on public.proofs_of_delivery
  for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
create policy "Drivers read proofs on their routes" on public.proofs_of_delivery
  for select to authenticated using (
    exists (select 1 from public.route_stops s where s.id = stop_id and s.route_id = any ((select app.my_route_ids())::uuid[]))
  );

-- ---------------------------------------------------------------------------
-- Tracking. Managers read their tenant; drivers read their own. Shifts are
-- opened and closed by the server (KaiWorkforce webhooks, route start).
-- Drivers upload their own GPS batches directly.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['shifts', 'gps_batches', 'trips', 'speed_events'] loop
    execute format(
      'create policy "Managers read" on public.%I for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]))', t);
    execute format(
      'create policy "Drivers read their own" on public.%I for select to authenticated using (driver_id = (select auth.uid()) and tenant_id = any ((select app.driver_tenant_ids())::uuid[]))', t);
  end loop;
end
$$;

grant insert on public.gps_batches to authenticated;
create policy "Drivers upload their own points" on public.gps_batches
  for insert to authenticated
  with check (
    driver_id = (select auth.uid())
    and tenant_id = any ((select app.driver_tenant_ids())::uuid[])
    and archived_at is null
    and (shift_id is null or exists (
      select 1 from public.shifts s where s.id = shift_id and s.driver_id = (select auth.uid())
    ))
  );

create policy "Managers read segment speeds" on public.segment_speeds
  for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));
