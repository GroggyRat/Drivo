-- Platform functions for KaiTech staff (platform_admins). They create and
-- suspend tenants and link them to BillZilla and KaiWorkforce. They return
-- counts, never tenant content, and platform admins see no tenant rows
-- through RLS because they are not members.

create or replace function app.slugify(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'))
$$;

create or replace function public.platform_list_tenants()
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
  routes_last_30_days integer
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
    (select count(*)::int from public.routes r where r.tenant_id = t.id and r.route_date >= current_date - 30)
  from public.tenants t
  order by t.name;
end;
$$;

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
  return v_id;
end;
$$;

create or replace function public.platform_set_tenant_status(p_tenant_id uuid, p_status public.tenant_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  update public.tenants
    set status = p_status,
        suspended_at = case when p_status = 'suspended' then coalesce(suspended_at, now()) end
    where id = p_tenant_id;
  if not found then
    raise exception 'Tenant not found' using errcode = '22023';
  end if;
end;
$$;

-- Link a tenant to its BillZilla organisation and KaiWorkforce company.
-- Webhooks find the tenant by these ids, so tenants cannot set them.
-- Pass an empty string to unlink.
create or replace function public.platform_link_tenant(
  p_tenant_id uuid,
  p_billzilla_org_id text default null,
  p_kaiworkforce_company_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  update public.tenants set
    billzilla_org_id = case when p_billzilla_org_id is null then billzilla_org_id else nullif(trim(p_billzilla_org_id), '') end,
    billzilla_enabled = case when p_billzilla_org_id is null then billzilla_enabled else nullif(trim(p_billzilla_org_id), '') is not null end,
    kaiworkforce_company_id = case when p_kaiworkforce_company_id is null then kaiworkforce_company_id else nullif(trim(p_kaiworkforce_company_id), '') end,
    kaiworkforce_enabled = case when p_kaiworkforce_company_id is null then kaiworkforce_enabled else nullif(trim(p_kaiworkforce_company_id), '') is not null end
  where id = p_tenant_id;
  if not found then
    raise exception 'Tenant not found' using errcode = '22023';
  end if;
end;
$$;

revoke all on function app.slugify(text) from public;
revoke all on function
  public.platform_list_tenants(),
  public.platform_create_tenant(text, text, text, text),
  public.platform_set_tenant_status(uuid, public.tenant_status),
  public.platform_link_tenant(uuid, text, text)
  from public, anon;
grant execute on function
  public.platform_list_tenants(),
  public.platform_create_tenant(text, text, text, text),
  public.platform_set_tenant_status(uuid, public.tenant_status),
  public.platform_link_tenant(uuid, text, text)
  to authenticated, service_role;
