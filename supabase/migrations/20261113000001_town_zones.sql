-- Town zones for every company, so the driver's speed limit sign and the
-- speed alerts use the urban limit (50 km/h by default) in Fiji's towns and
-- the highway limit (80) between them, without KaiTech drawing zones by hand.
-- The boxes are approximate town areas, not surveyed limits: a company's
-- zones can be corrected or given their own limit later.

create or replace function app.add_default_speed_zones(p_tenant_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.speed_zones (tenant_id, name, area)
  select p_tenant_id, z.name,
    extensions.st_multi(extensions.st_makeenvelope(z.w, z.s, z.e, z.n, 4326))::extensions.geography
  from (values
    ('Suva, Lami and Nasinu', 178.380, -18.170, 178.530, -18.060),
    ('Nausori Town',          178.510, -18.045, 178.550, -18.015),
    ('Navua Town',            178.155, -18.235, 178.185, -18.210),
    ('Sigatoka Town',         177.495, -18.150, 177.520, -18.130),
    ('Nadi Town and Namaka',  177.400, -17.815, 177.460, -17.740),
    ('Lautoka City',          177.430, -17.640, 177.480, -17.585),
    ('Ba Town',               177.660, -17.550, 177.690, -17.520),
    ('Tavua Town',            177.850, -17.455, 177.875, -17.435),
    ('Rakiraki Town',         178.140, -17.385, 178.165, -17.360),
    ('Labasa Town',           179.360, -16.445, 179.400, -16.415),
    ('Savusavu Town',         179.320, -16.790, 179.350, -16.770),
    ('Levuka Town',           178.825, -17.695, 178.845, -17.670)
  ) as z (name, w, s, e, n)
  where not exists (select 1 from public.speed_zones x where x.tenant_id = p_tenant_id);
$$;
revoke all on function app.add_default_speed_zones(uuid) from public;
grant execute on function app.add_default_speed_zones(uuid) to service_role;

-- Companies that have no zones yet get the defaults now.
select app.add_default_speed_zones(t.id) from public.tenants t;

-- New companies get them when the platform creates them.
create or replace function public.platform_create_tenant(
  p_name text,
  p_slug text default null,
  p_time_zone text default 'Pacific/Fiji',
  p_contact_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text;
  v_id uuid;
begin
  if not app.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'Unknown time zone %', p_time_zone using errcode = '22023';
  end if;
  v_slug := left(app.slugify(coalesce(nullif(p_slug, ''), p_name)), 40);
  insert into public.tenants (name, slug, time_zone, contact_email)
  values (trim(p_name), v_slug, p_time_zone, nullif(lower(trim(p_contact_email)), ''))
  returning id into v_id;
  perform app.add_default_speed_zones(v_id);
  return v_id;
end;
$$;
