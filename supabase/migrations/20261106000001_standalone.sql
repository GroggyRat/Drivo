-- Drivo on its own, for companies without BillZilla or KaiWorkforce:
--   * drivers clock in and out in the Drivo app, and tracking follows the shift;
--   * admins add a delivery with a place and the invoice as a PDF.

-- ---------------------------------------------------------------------------
-- Clock-in in the Drivo app. Companies linked to KaiWorkforce keep clocking in
-- there; everyone else clocks in here. Starting a route without clocking in
-- still opens a route shift, as before.
-- ---------------------------------------------------------------------------
-- The driver's company: the one asked for, or their first.
create or replace function app.my_driver_tenant(p_tenant_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t from unnest(app.driver_tenant_ids()) as t
  where p_tenant_id is null or t = p_tenant_id
  order by t
  limit 1;
$$;

create or replace function app.shift_state(p_tenant_id uuid, p_driver_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tenant_id', t.id,
    'clock_in_here', not t.kaiworkforce_enabled,
    'tracking', s.id is not null,
    'shift', case when s.id is null then null else jsonb_build_object('id', s.id, 'source', s.source, 'started_at', s.started_at) end
  )
  from public.tenants t
  left join public.shifts s on s.tenant_id = t.id and s.driver_id = p_driver_id and s.ended_at is null
  where t.id = p_tenant_id;
$$;

-- What the driver app shows: whether to offer Clock in, and the open shift.
create or replace function public.my_shift(p_tenant_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := app.my_driver_tenant(p_tenant_id);
begin
  if v_tenant is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return app.shift_state(v_tenant, auth.uid());
end;
$$;

create or replace function public.clock_in(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := app.my_driver_tenant(p_tenant_id);
  v_kw boolean;
begin
  if v_tenant is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select kaiworkforce_enabled into v_kw from public.tenants where id = v_tenant and status = 'active';
  if v_kw is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if v_kw then
    raise exception 'Your company clocks in through KaiWorkforce' using errcode = '22023';
  end if;
  insert into public.shifts (tenant_id, driver_id, source, started_at)
  values (v_tenant, auth.uid(), 'drivo', now())
  on conflict (tenant_id, driver_id) where ended_at is null do nothing;
  return app.shift_state(v_tenant, auth.uid());
end;
$$;

-- Ends tracking. Shifts from KaiWorkforce end only from KaiWorkforce.
create or replace function public.clock_out(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := app.my_driver_tenant(p_tenant_id);
begin
  if v_tenant is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from public.shifts where tenant_id = v_tenant and driver_id = auth.uid()
             and ended_at is null and source = 'kaiworkforce') then
    raise exception 'Clock out in KaiWorkforce' using errcode = '22023';
  end if;
  update public.shifts set ended_at = now()
    where tenant_id = v_tenant and driver_id = auth.uid() and ended_at is null;
  return app.shift_state(v_tenant, auth.uid());
end;
$$;

-- Nightly: a driver who forgot to clock out stops being tracked after 16
-- hours, ending at their last upload. KaiWorkforce shifts are left alone.
create or replace function public.close_forgotten_shifts()
returns integer
language sql
security definer
set search_path = ''
as $$
  with closed as (
    update public.shifts s
    set ended_at = greatest(s.started_at, coalesce(
      (select max(b.recorded_to) from public.gps_batches b where b.shift_id = s.id),
      s.started_at + interval '16 hours'))
    where s.ended_at is null
      and s.source in ('drivo', 'route')
      and s.started_at < now() - interval '16 hours'
    returning 1
  )
  select count(*)::integer from closed;
$$;

revoke all on function app.my_driver_tenant(uuid), app.shift_state(uuid, uuid) from public, anon, authenticated;
revoke all on function public.my_shift(uuid), public.clock_in(uuid), public.clock_out(uuid) from public, anon;
grant execute on function public.my_shift(uuid), public.clock_in(uuid), public.clock_out(uuid) to authenticated, service_role;
revoke all on function public.close_forgotten_shifts() from public, anon, authenticated;
grant execute on function public.close_forgotten_shifts() to service_role;

-- ---------------------------------------------------------------------------
-- Invoice PDFs on orders added in Drivo.
--   invoices/<tenant_id>/<upload id>.pdf
-- Managers upload and read their company's invoices; drivers read the
-- invoices for orders on their routes.
-- ---------------------------------------------------------------------------
alter table public.orders add column invoice_pdf_path text;
alter table public.orders add constraint orders_invoice_in_tenant
  check (invoice_pdf_path is null or invoice_pdf_path like tenant_id::text || '/%.pdf');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

create policy "Managers upload invoices" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'invoices'
    and (storage.foldername(name))[1] = any ((select app.manager_tenant_ids())::text[])
  );

create policy "Managers and drivers on the route read invoices" on storage.objects
  for select to authenticated using (
    bucket_id = 'invoices'
    and (
      (storage.foldername(name))[1] = any ((select app.manager_tenant_ids())::text[])
      or exists (
        select 1 from public.orders o
        where o.invoice_pdf_path = objects.name
          and o.id = any ((select app.my_order_ids())::uuid[])
      )
    )
  );
