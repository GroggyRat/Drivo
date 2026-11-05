-- Functions the apps call (Supabase RPC). Locations are written only
-- through these, so the duplicate check, approval rules and audit columns
-- cannot be skipped.

create or replace function app.make_point(p_lon double precision, p_lat double precision)
returns extensions.geography
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_lon is null or p_lat is null or p_lon < -180 or p_lon > 180 or p_lat < -90 or p_lat > 90 then
    raise exception 'Longitude must be -180 to 180 and latitude -90 to 90' using errcode = '22023';
  end if;
  return extensions.st_setsrid(extensions.st_makepoint(p_lon, p_lat), 4326)::extensions.geography;
end;
$$;

-- ---------------------------------------------------------------------------
-- Nearby locations, for the duplicate warning when dropping a pin and for
-- "what is around here". Runs as the caller, so drivers only see what RLS
-- lets them see.
-- ---------------------------------------------------------------------------
create or replace function public.nearby_locations(
  p_tenant_id uuid,
  p_lon double precision,
  p_lat double precision,
  p_radius_m double precision default null
)
returns table (id uuid, name text, type public.location_type, status public.location_status, distance_m double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  with here as (
    select app.make_point(p_lon, p_lat) as g,
      coalesce(p_radius_m, (select s.duplicate_radius_m from public.tenant_settings s where s.tenant_id = p_tenant_id), 30) as r
  )
  select l.id, l.name, l.type, l.status, extensions.st_distance(l.point, here.g) as distance_m
  from public.locations l, here
  where l.tenant_id = p_tenant_id
    and l.status <> 'rejected'
    and extensions.st_dwithin(l.point, here.g, least(here.r, 5000))
  order by distance_m
  limit 50
$$;

-- ---------------------------------------------------------------------------
-- Drop a pin. Drivers' and dispatchers' pins wait for review; an Owner's or
-- Admin's pin is approved straight away. Returns the new id and any
-- locations within the duplicate radius, so the app can warn.
-- ---------------------------------------------------------------------------
create or replace function public.submit_location(
  p_tenant_id uuid,
  p_name text,
  p_type public.location_type,
  p_lon double precision,
  p_lat double precision,
  p_accuracy_m double precision default null,
  p_landmark_directions text default null,
  p_photo_path text default null,
  p_address text default null,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.member_role := app.member_role(p_tenant_id);
  v_uid uuid := auth.uid();
  v_point extensions.geography := app.make_point(p_lon, p_lat);
  v_radius integer;
  v_id uuid;
  v_nearby jsonb;
  v_auto_approve boolean;
begin
  if v_role is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_accuracy_m is not null and p_accuracy_m > 30 and p_type <> 'hazard' then
    raise exception 'Location accuracy is % m. Wait for a fix within 30 m and try again', round(p_accuracy_m::numeric)
      using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The expiry must be in the future' using errcode = '22023';
  end if;

  select s.duplicate_radius_m into v_radius from public.tenant_settings s where s.tenant_id = p_tenant_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'name', l.name, 'type', l.type, 'status', l.status,
           'distance_m', round(extensions.st_distance(l.point, v_point)::numeric, 1)
         ) order by extensions.st_distance(l.point, v_point)), '[]'::jsonb)
    into v_nearby
  from public.locations l
  where l.tenant_id = p_tenant_id
    and l.status <> 'rejected'
    and extensions.st_dwithin(l.point, v_point, coalesce(v_radius, 30))
    -- Drivers are only told about pins they could see anyway.
    and (v_role <> 'driver' or l.status = 'approved' or l.created_by = v_uid);

  v_auto_approve := v_role in ('owner', 'admin');

  insert into public.locations (
    tenant_id, name, type, point, address, landmark_directions, photo_path, accuracy_m,
    status, created_by, approved_by, approved_at, expires_at
  ) values (
    p_tenant_id, trim(p_name), p_type, v_point, nullif(trim(p_address), ''), nullif(trim(p_landmark_directions), ''),
    p_photo_path, p_accuracy_m,
    case when v_auto_approve then 'approved' else 'pending' end::public.location_status,
    v_uid,
    case when v_auto_approve then v_uid end,
    case when v_auto_approve then now() end,
    p_expires_at
  )
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'status', case when v_auto_approve then 'approved' else 'pending' end,
    'nearby', v_nearby
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Approve or reject a pin (Owners and Admins). Approving can link one or
-- more customers to the location in the same step.
-- ---------------------------------------------------------------------------
create or replace function public.review_location(
  p_location_id uuid,
  p_approve boolean,
  p_reason text default null,
  p_customer_ids uuid[] default null
)
returns public.locations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loc public.locations;
  v_uid uuid := auth.uid();
begin
  select * into v_loc from public.locations where id = p_location_id for update;
  if not found or not (v_loc.tenant_id = any (app.admin_tenant_ids())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if p_approve then
    update public.locations
      set status = 'approved', approved_by = v_uid, approved_at = now(),
          rejected_by = null, rejected_at = null, rejected_reason = null
      where id = p_location_id
      returning * into v_loc;
    if p_customer_ids is not null and cardinality(p_customer_ids) > 0 then
      if exists (
        select 1 from unnest(p_customer_ids) cid
        where not exists (select 1 from public.customers c where c.id = cid and c.tenant_id = v_loc.tenant_id)
      ) then
        raise exception 'Customer not found' using errcode = '22023';
      end if;
      update public.customers set location_id = p_location_id
        where id = any (p_customer_ids) and tenant_id = v_loc.tenant_id;
    end if;
  else
    if exists (select 1 from public.customers c where c.location_id = p_location_id) then
      raise exception 'Customers are linked to this location. Link them somewhere else first'
        using errcode = '23514';
    end if;
    update public.locations
      set status = 'rejected', rejected_by = v_uid, rejected_at = now(),
          rejected_reason = nullif(trim(p_reason), ''),
          approved_by = null, approved_at = null
      where id = p_location_id
      returning * into v_loc;
  end if;
  return v_loc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Edit a location (Owners and Admins). Null arguments leave a field as is.
-- ---------------------------------------------------------------------------
create or replace function public.update_location(
  p_location_id uuid,
  p_name text default null,
  p_type public.location_type default null,
  p_lon double precision default null,
  p_lat double precision default null,
  p_landmark_directions text default null,
  p_address text default null,
  p_expires_at timestamptz default null,
  p_clear_expiry boolean default false
)
returns public.locations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loc public.locations;
begin
  select * into v_loc from public.locations where id = p_location_id for update;
  if not found or not (v_loc.tenant_id = any (app.admin_tenant_ids())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if (p_lon is null) <> (p_lat is null) then
    raise exception 'Give both longitude and latitude' using errcode = '22023';
  end if;

  update public.locations set
    name = coalesce(nullif(trim(p_name), ''), name),
    type = coalesce(p_type, type),
    point = case when p_lon is not null then app.make_point(p_lon, p_lat) else point end,
    landmark_directions = coalesce(p_landmark_directions, landmark_directions),
    address = coalesce(p_address, address),
    expires_at = case when p_clear_expiry then null else coalesce(p_expires_at, expires_at) end
  where id = p_location_id
  returning * into v_loc;
  return v_loc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Speed limit at a point: the smallest limit of the active zones that
-- contain it (a zone with no limit uses the tenant's urban limit), or the
-- highway limit outside every zone.
-- ---------------------------------------------------------------------------
create or replace function app.speed_limit_at(p_tenant_id uuid, p_point extensions.geography)
returns table (limit_kmh integer, zone_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.limit_kmh, c.zone_name
  from (
    select coalesce(z.limit_kmh, s.urban_speed_limit_kmh) as limit_kmh, z.name as zone_name, 0 as rank
    from public.tenant_settings s
    join public.speed_zones z on z.tenant_id = s.tenant_id and z.active
    where s.tenant_id = p_tenant_id and extensions.st_intersects(z.area, p_point)
    union all
    select s.highway_speed_limit_kmh, null, 1
    from public.tenant_settings s
    where s.tenant_id = p_tenant_id
  ) c
  order by c.rank, c.limit_kmh
  limit 1
$$;

create or replace function public.speed_limit_at(p_tenant_id uuid, p_lon double precision, p_lat double precision)
returns table (limit_kmh integer, zone_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if app.member_role(p_tenant_id) is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query select * from app.speed_limit_at(p_tenant_id, app.make_point(p_lon, p_lat));
end;
$$;

-- ---------------------------------------------------------------------------
-- Acknowledge a speed alert (Owners, Admins, Dispatchers).
-- ---------------------------------------------------------------------------
create or replace function public.acknowledge_speed_event(p_event_id uuid)
returns public.speed_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.speed_events;
begin
  select * into v_event from public.speed_events where id = p_event_id for update;
  if not found or not (v_event.tenant_id = any (app.manager_tenant_ids())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if v_event.acknowledged_at is null then
    update public.speed_events set acknowledged_by = auth.uid(), acknowledged_at = now()
      where id = p_event_id
      returning * into v_event;
  end if;
  return v_event;
end;
$$;

revoke all on function app.make_point(double precision, double precision) from public;
revoke all on function app.speed_limit_at(uuid, extensions.geography) from public;
grant execute on function app.make_point(double precision, double precision) to authenticated, service_role;
grant execute on function app.speed_limit_at(uuid, extensions.geography) to service_role;

revoke all on function
  public.nearby_locations(uuid, double precision, double precision, double precision),
  public.submit_location(uuid, text, public.location_type, double precision, double precision, double precision, text, text, text, timestamptz),
  public.review_location(uuid, boolean, text, uuid[]),
  public.update_location(uuid, text, public.location_type, double precision, double precision, text, text, timestamptz, boolean),
  public.speed_limit_at(uuid, double precision, double precision),
  public.acknowledge_speed_event(uuid)
  from public, anon;
grant execute on function
  public.nearby_locations(uuid, double precision, double precision, double precision),
  public.submit_location(uuid, text, public.location_type, double precision, double precision, double precision, text, text, text, timestamptz),
  public.review_location(uuid, boolean, text, uuid[]),
  public.update_location(uuid, text, public.location_type, double precision, double precision, text, text, timestamptz, boolean),
  public.speed_limit_at(uuid, double precision, double precision),
  public.acknowledge_speed_event(uuid)
  to authenticated, service_role;
