-- Xero: a company's Admin connects their Xero organisation (OAuth, in
-- Settings), and its approved sales invoices arrive in Ready for delivery,
-- the same way BillZilla invoices do.
--
--   * xero_connections holds the link and the tokens. The tokens are
--     encrypted by the web server before they are stored, and that column is
--     not readable through the API at all; only the server (service role)
--     reads and writes this table.
--   * Webhooks find the company by xero_tenant_id, which is set only by the
--     server after the Admin signs in to Xero, never typed by anyone.
--   * Customers and invoices from Xero are written only by xero_ingest and
--     cannot be renamed or edited in Drivo, like BillZilla ones.
--
-- Comparisons with the new 'xero' source go through text, so this file also
-- runs in one transaction together with the migration that adds the value.

alter table public.customers
  add column xero_contact_id text,
  add constraint customers_xero_contact unique (tenant_id, xero_contact_id),
  add constraint customers_xero_id check ((source::text = 'xero') = (xero_contact_id is not null));

alter table public.orders
  add column xero_invoice_id text,
  -- The invoice status in Xero, as sent (AUTHORISED, PAID, VOIDED).
  add column xero_status text,
  add constraint orders_xero_invoice unique (tenant_id, xero_invoice_id),
  add constraint orders_xero_id check ((source::text = 'xero') = (xero_invoice_id is not null));

-- People add and edit only what was made in Drivo.
drop policy "Managers add customers" on public.customers;
create policy "Managers add customers" on public.customers
  for insert to authenticated
  with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]) and source::text not in ('billzilla', 'xero'));
drop policy "Managers add orders" on public.orders;
create policy "Managers add orders" on public.orders
  for insert to authenticated
  with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]) and source::text not in ('billzilla', 'xero'));
drop policy "Managers update their own orders" on public.orders;
create policy "Managers update their own orders" on public.orders
  for update to authenticated
  using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]) and source::text not in ('billzilla', 'xero'))
  with check (tenant_id = any ((select app.manager_tenant_ids())::uuid[]) and source::text not in ('billzilla', 'xero'));

-- A synced customer can be moved to another approved shop, but its name,
-- phone, id and source come from where it was made.
create or replace function app.customers_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  if new.source is distinct from old.source
     or new.billzilla_customer_id is distinct from old.billzilla_customer_id
     or new.xero_contact_id is distinct from old.xero_contact_id
     or (old.source::text in ('billzilla', 'xero') and (new.name is distinct from old.name or new.phone is distinct from old.phone)) then
    raise exception 'This customer''s details are changed in %', case when old.source::text = 'xero' then 'Xero' else 'BillZilla' end
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create table public.xero_connections (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  -- The Xero organisation. One Xero organisation feeds one Drivo company.
  xero_tenant_id text not null unique,
  -- Xero's id for this connection, used to disconnect.
  xero_connection_id text,
  org_name text not null,
  -- Access and refresh tokens, encrypted by the web server (AES-256-GCM).
  token_ciphertext text not null,
  -- Only invoices dated on or after this are brought in.
  import_from date not null,
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz not null default now(),
  -- A sync asked for by a Xero webhook, waiting to run.
  sync_requested_at timestamptz,
  sync_started_at timestamptz,
  last_sync_at timestamptz,
  last_sync_count integer,
  last_error text,
  updated_at timestamptz not null default now()
);
create trigger xero_connections_touch before update on public.xero_connections
  for each row execute function app.touch_updated_at();

alter table public.xero_connections enable row level security;
revoke all on public.xero_connections from anon, authenticated;
grant all on public.xero_connections to service_role;
grant select (tenant_id, org_name, import_from, connected_at, last_sync_at, last_sync_count, last_error)
  on public.xero_connections to authenticated;
create policy "Managers see their Xero connection" on public.xero_connections
  for select to authenticated using (tenant_id = any ((select app.manager_tenant_ids())::uuid[]));

-- ---------------------------------------------------------------------------
-- Store what a sync read from Xero (server only). p_invoices is a list of:
--   { id, number, status, date, currency, total, cartons, lines: [...],
--     customer: { id, name, phone, address } }
-- AUTHORISED and PAID invoices are stored or updated; VOIDED and DELETED ones
-- are cancelled the way a cancelled BillZilla invoice is.
-- ---------------------------------------------------------------------------
create or replace function public.xero_ingest(p_tenant_id uuid, p_invoices jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv jsonb;
  v_cust jsonb;
  v_customer uuid;
  v_order public.orders;
  v_reference text;
  v_stored integer := 0;
  v_cancelled integer := 0;
  v_skipped integer := 0;
begin
  if not exists (
    select 1 from public.tenants t join public.xero_connections x on x.tenant_id = t.id
    where t.id = p_tenant_id and t.status = 'active'
  ) then
    raise exception 'This company is not connected to Xero' using errcode = '22023';
  end if;

  for v_inv in select * from jsonb_array_elements(coalesce(p_invoices, '[]'::jsonb)) loop
    if upper(coalesce(v_inv ->> 'status', '')) in ('VOIDED', 'DELETED') then
      select * into v_order from public.orders where tenant_id = p_tenant_id and xero_invoice_id = v_inv ->> 'id' for update;
      if found and v_order.delivery_status not in ('delivered', 'partially_delivered', 'cancelled') then
        -- Off routes that have not started; kept on one in progress so the
        -- dispatcher can tell the driver.
        delete from public.route_stops s using public.routes r
          where r.id = s.route_id and s.order_id = v_order.id and r.status in ('draft', 'sent');
        update public.orders set delivery_status = 'cancelled', xero_status = upper(v_inv ->> 'status') where id = v_order.id;
        v_cancelled := v_cancelled + 1;
      else
        v_skipped := v_skipped + 1;
      end if;
      continue;
    end if;

    v_cust := v_inv -> 'customer';
    if v_cust is null or coalesce(v_cust ->> 'id', '') = '' or coalesce(v_inv ->> 'id', '') = '' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.customers (tenant_id, source, xero_contact_id, name, phone, address)
    values (p_tenant_id, 'xero', v_cust ->> 'id', left(coalesce(nullif(trim(v_cust ->> 'name'), ''), 'Xero customer'), 200), v_cust ->> 'phone', v_cust ->> 'address')
    on conflict (tenant_id, xero_contact_id) do update set
      name = excluded.name,
      phone = coalesce(excluded.phone, public.customers.phone),
      address = coalesce(excluded.address, public.customers.address)
    returning id into v_customer;

    -- References are unique in a company. If an order added by hand already
    -- uses this invoice number, the Xero one is marked so both are kept.
    v_reference := left(coalesce(nullif(trim(v_inv ->> 'number'), ''), v_inv ->> 'id'), 90);
    if exists (
      select 1 from public.orders o
      where o.tenant_id = p_tenant_id and o.reference = v_reference and o.xero_invoice_id is distinct from v_inv ->> 'id'
    ) then
      v_reference := v_reference || ' (Xero)';
    end if;

    insert into public.orders (
      tenant_id, source, xero_invoice_id, reference, customer_id, customer_name, cartons, line_items,
      total_amount, currency, xero_status, confirmed_at
    ) values (
      p_tenant_id, 'xero', v_inv ->> 'id', v_reference, v_customer, left(coalesce(nullif(trim(v_cust ->> 'name'), ''), 'Xero customer'), 200),
      greatest(coalesce((v_inv ->> 'cartons')::integer, 0), 0), coalesce(v_inv -> 'lines', '[]'::jsonb),
      (v_inv ->> 'total')::numeric, coalesce(nullif(v_inv ->> 'currency', ''), 'FJD'), upper(v_inv ->> 'status'),
      coalesce((v_inv ->> 'date')::timestamptz, now())
    )
    on conflict (tenant_id, xero_invoice_id) do update set
      reference = excluded.reference,
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      cartons = excluded.cartons,
      line_items = excluded.line_items,
      total_amount = excluded.total_amount,
      currency = excluded.currency,
      xero_status = excluded.xero_status,
      delivery_status = case when public.orders.delivery_status = 'cancelled' then 'ready' else public.orders.delivery_status end
    returning * into v_order;
    v_stored := v_stored + 1;
  end loop;

  return jsonb_build_object('stored', v_stored, 'cancelled', v_cancelled, 'skipped', v_skipped);
end;
$$;

revoke all on function public.xero_ingest(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.xero_ingest(uuid, jsonb) to service_role;
