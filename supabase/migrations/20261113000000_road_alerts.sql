-- Road alerts: an add-on the platform turns on per company. Drivers report a
-- hazard, a police checkpoint or a speed camera with two taps, and every
-- driver of every company with the add-on is warned as they approach it.
--
-- Sharing across companies is the point (one company's drivers are too few
-- to cover the road), so it is the one place where rows cross tenants, and
-- it is kept narrow:
--   * the table is readable only by the reporting company's managers;
--   * everyone else reads through road_alerts_near, which returns the kind,
--     the place and the time, never who reported it or which company;
--   * writes go only through report_road_alert and vote_road_alert.

alter table public.tenants add column road_alerts_enabled boolean not null default false;
-- Not in the columns Admins may update, so only platform_set_road_alerts sets it.

create type public.road_alert_kind as enum ('hazard', 'police', 'speed_camera');

create table public.road_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  reported_by uuid not null,
  kind public.road_alert_kind not null,
  point extensions.geography(Point, 4326) not null,
  lon double precision generated always as (extensions.st_x(point::extensions.geometry)) stored,
  lat double precision generated always as (extensions.st_y(point::extensions.geometry)) stored,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Set when drivers say it is gone, or the reporter takes it back.
  ended_at timestamptz,
  -- People who said "Still there" and "Not there". They can be from other
  -- companies, so these columns are not readable through the API.
  confirmed_by uuid[] not null default '{}',
  denied_by uuid[] not null default '{}',
  unique (id, tenant_id),
  foreign key (tenant_id, reported_by) references public.memberships (tenant_id, user_id)
);
create index road_alerts_open on public.road_alerts using gist (point) where ended_at is null;
create index road_alerts_tenant on public.road_alerts (tenant_id, created_at desc);
create index road_alerts_reporter on public.road_alerts (reported_by, created_at desc);

alter table public.road_alerts enable row level security;
revoke all on public.road_alerts from anon, authenticated;
grant all on public.road_alerts to service_role;
grant select (id, tenant_id, reported_by, kind, lon, lat, created_at, expires_at, ended_at)
  on public.road_alerts to authenticated;
create policy "Managers read their company's reports" on public.road_alerts
  for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));

-- How long a report stays up without anyone confirming it. A confirmation
-- starts the time again.
create or replace function app.road_alert_ttl(p_kind public.road_alert_kind)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'police' then interval '2 hours'
    when 'hazard' then interval '4 hours'
    else interval '7 days'
  end
$$;

-- The caller's company that has road alerts: the one asked for, or their
-- first. Suspended companies and deactivated people drop out in
-- app.active_memberships.
create or replace function app.road_alerts_tenant(p_tenant_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select am.tenant_id
  from app.active_memberships() am
  join public.tenants t on t.id = am.tenant_id
  where t.road_alerts_enabled and (p_tenant_id is null or am.tenant_id = p_tenant_id)
  order by am.tenant_id
  limit 1
$$;

create or replace function app.road_alert_json(a public.road_alerts)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'kind', a.kind, 'lon', a.lon, 'lat', a.lat, 'reported_at', a.created_at,
    'confirmations', cardinality(a.confirmed_by),
    'active', a.ended_at is null and a.expires_at > now(),
    'mine', a.reported_by = auth.uid(),
    'voted', auth.uid() = any (a.confirmed_by || a.denied_by)
  )
$$;

-- Report something on the road. A second report of the same thing within
-- 200 m counts as "Still there" on the first one.
create or replace function public.report_road_alert(
  p_kind public.road_alert_kind,
  p_lon double precision,
  p_lat double precision,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := app.road_alerts_tenant(p_tenant_id);
  v_point extensions.geography := app.make_point(p_lon, p_lat);
  v_alert public.road_alerts;
begin
  if v_tenant is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if (select count(*) from public.road_alerts a where a.reported_by = auth.uid() and a.created_at > now() - interval '1 hour') >= 12 then
    raise exception 'Too many reports in the last hour. Try again later.' using errcode = '22023';
  end if;

  select a.* into v_alert
  from public.road_alerts a
  where a.ended_at is null and a.expires_at > now() and a.kind = p_kind
    and extensions.st_dwithin(a.point, v_point, 200)
  order by extensions.st_distance(a.point, v_point)
  limit 1
  for update;

  if found then
    update public.road_alerts a set
      expires_at = greatest(a.expires_at, now() + app.road_alert_ttl(a.kind)),
      denied_by = array_remove(a.denied_by, auth.uid()),
      confirmed_by = case
        when a.reported_by = auth.uid() or auth.uid() = any (a.confirmed_by) then a.confirmed_by
        else a.confirmed_by || auth.uid()
      end
    where a.id = v_alert.id
    returning a.* into v_alert;
  else
    insert into public.road_alerts (tenant_id, reported_by, kind, point, expires_at)
    values (v_tenant, auth.uid(), p_kind, v_point, now() + app.road_alert_ttl(p_kind))
    returning * into v_alert;
  end if;
  return app.road_alert_json(v_alert);
end;
$$;

-- "Still there" or "Not there". The reporter saying "Not there" takes the
-- report back. Otherwise it clears once more people say it is gone than say
-- it is still there.
create or replace function public.vote_road_alert(
  p_alert_id uuid,
  p_still_there boolean,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert public.road_alerts;
  v_confirmed uuid[];
  v_denied uuid[];
begin
  if app.road_alerts_tenant(p_tenant_id) is null or p_still_there is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select a.* into v_alert from public.road_alerts a
  where a.id = p_alert_id and a.ended_at is null and a.expires_at > now()
  for update;
  if not found then
    return jsonb_build_object('id', p_alert_id, 'active', false);
  end if;

  v_confirmed := array_remove(v_alert.confirmed_by, auth.uid());
  v_denied := array_remove(v_alert.denied_by, auth.uid());
  if p_still_there then
    if v_alert.reported_by <> auth.uid() then
      v_confirmed := v_confirmed || auth.uid();
    end if;
    update public.road_alerts a set
      confirmed_by = v_confirmed, denied_by = v_denied,
      expires_at = greatest(a.expires_at, now() + app.road_alert_ttl(a.kind))
    where a.id = p_alert_id returning a.* into v_alert;
  else
    if v_alert.reported_by <> auth.uid() then
      v_denied := v_denied || auth.uid();
    end if;
    update public.road_alerts a set
      confirmed_by = v_confirmed, denied_by = v_denied,
      ended_at = case
        when a.reported_by = auth.uid() or cardinality(v_denied) > cardinality(v_confirmed) then now()
      end
    where a.id = p_alert_id returning a.* into v_alert;
  end if;
  return app.road_alert_json(v_alert);
end;
$$;

-- Open alerts around a point, nearest first, from every company with the
-- add-on. No reporter and no company in the result.
create or replace function public.road_alerts_near(
  p_lon double precision,
  p_lat double precision,
  p_radius_m integer default 50000,
  p_tenant_id uuid default null
)
returns table (
  id uuid,
  kind public.road_alert_kind,
  lon double precision,
  lat double precision,
  reported_at timestamptz,
  confirmations integer,
  mine boolean,
  voted boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_point extensions.geography := app.make_point(p_lon, p_lat);
begin
  if app.road_alerts_tenant(p_tenant_id) is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
  select a.id, a.kind, a.lon, a.lat, a.created_at, cardinality(a.confirmed_by),
    a.reported_by = auth.uid(), auth.uid() = any (a.confirmed_by || a.denied_by)
  from public.road_alerts a
  where a.ended_at is null and a.expires_at > now()
    and extensions.st_dwithin(a.point, v_point, least(greatest(coalesce(p_radius_m, 50000), 100), 2000000))
  order by extensions.st_distance(a.point, v_point)
  limit 200;
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform: turn the add-on on or off for a company, and show it in the list.
-- ---------------------------------------------------------------------------
create or replace function public.platform_set_road_alerts(p_tenant_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  update public.tenants set road_alerts_enabled = coalesce(p_enabled, false) where id = p_tenant_id;
  if not found then
    raise exception 'Tenant not found' using errcode = '22023';
  end if;
end;
$$;

drop function public.platform_list_tenants();
create function public.platform_list_tenants()
returns table (
  id uuid,
  name text,
  slug text,
  status public.tenant_status,
  created_at timestamptz,
  billzilla_linked boolean,
  kaiworkforce_linked boolean,
  people integer,
  drivers integer,
  vehicles integer,
  routes_last_30_days integer,
  road_alerts_enabled boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
  select t.id, t.name, t.slug, t.status, t.created_at,
    t.billzilla_org_id is not null, t.kaiworkforce_company_id is not null,
    (select count(*)::int from public.memberships m where m.tenant_id = t.id and m.active),
    (select count(*)::int from public.memberships m where m.tenant_id = t.id and m.active and m.role = 'driver'),
    (select count(*)::int from public.vehicles v where v.tenant_id = t.id and v.active),
    (select count(*)::int from public.routes r where r.tenant_id = t.id and r.route_date >= current_date - 30),
    t.road_alerts_enabled
  from public.tenants t
  order by t.name;
end;
$$;

revoke all on function
  app.road_alert_ttl(public.road_alert_kind),
  app.road_alerts_tenant(uuid),
  app.road_alert_json(public.road_alerts)
  from public;
grant execute on function
  app.road_alert_ttl(public.road_alert_kind),
  app.road_alerts_tenant(uuid),
  app.road_alert_json(public.road_alerts)
  to service_role;
revoke all on function
  public.report_road_alert(public.road_alert_kind, double precision, double precision, uuid),
  public.vote_road_alert(uuid, boolean, uuid),
  public.road_alerts_near(double precision, double precision, integer, uuid),
  public.platform_set_road_alerts(uuid, boolean),
  public.platform_list_tenants()
  from public, anon;
grant execute on function
  public.report_road_alert(public.road_alert_kind, double precision, double precision, uuid),
  public.vote_road_alert(uuid, boolean, uuid),
  public.road_alerts_near(double precision, double precision, integer, uuid),
  public.platform_set_road_alerts(uuid, boolean),
  public.platform_list_tenants()
  to authenticated, service_role;
