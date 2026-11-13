-- Billing and deleting companies, for the platform console.
--
-- Billing is a simple ledger kept by KaiTech: each company has a monthly fee
-- and the date its next payment is due. Recording a payment moves that date
-- on by the months paid for. The road alerts add-on adds FJD 25 a month.
-- Drivo does not take money; it shows what is due and when.

create table public.tenant_billing (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  monthly_fee numeric(10, 2) not null default 0 check (monthly_fee >= 0 and monthly_fee < 100000),
  -- Null until KaiTech sets the first due date.
  next_due_on date,
  updated_at timestamptz not null default now()
);
create trigger tenant_billing_touch before update on public.tenant_billing
  for each row execute function app.touch_updated_at();

create table public.tenant_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  amount numeric(10, 2) not null check (amount >= 0 and amount < 1000000),
  paid_on date not null,
  -- The due date this payment covered, and how many months it paid for.
  due_on date,
  months integer not null default 1 check (months between 1 and 24),
  reference text check (reference is null or char_length(reference) <= 200),
  recorded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, tenant_id)
);
create index tenant_payments_tenant on public.tenant_payments (tenant_id, paid_on desc);

-- A company's Owner and Admins can read their own billing; only the platform writes.
do $$
declare
  t text;
begin
  foreach t in array array['tenant_billing', 'tenant_payments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format(
      'create policy "Admins read their billing" on public.%I for select to authenticated using (tenant_id = any ((select app.admin_tenant_ids())::uuid[]))', t);
  end loop;
end
$$;

create or replace function app.tenants_add_billing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tenant_billing (tenant_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
create trigger tenants_add_billing after insert on public.tenants
  for each row execute function app.tenants_add_billing();
insert into public.tenant_billing (tenant_id) select id from public.tenants on conflict do nothing;

-- Today in Fiji, where KaiTech bills from.
create or replace function app.billing_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Pacific/Fiji')::date
$$;

-- Every company with what it pays a month, when the next payment is due and
-- how much is owed now (one month for each due date that has passed).
create or replace function public.platform_billing()
returns table (
  id uuid,
  name text,
  slug text,
  status public.tenant_status,
  monthly_fee numeric,
  road_alerts_enabled boolean,
  monthly_total numeric,
  next_due_on date,
  days_until_due integer,
  months_due integer,
  amount_due numeric,
  last_paid_on date,
  last_paid_amount numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := app.billing_today();
begin
  if not app.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
  select t.id, t.name, t.slug, t.status, b.monthly_fee, t.road_alerts_enabled, c.total, b.next_due_on,
    (b.next_due_on - v_today)::int,
    c.months,
    (c.total * c.months)::numeric,
    p.paid_on, p.amount
  from public.tenants t
  join public.tenant_billing b on b.tenant_id = t.id
  cross join lateral (
    select
      (b.monthly_fee + case when t.road_alerts_enabled then 25 else 0 end)::numeric as total,
      case
        when b.next_due_on is null or b.next_due_on > v_today then 0
        else (extract(year from age(v_today, b.next_due_on)) * 12 + extract(month from age(v_today, b.next_due_on)))::int + 1
      end as months
  ) c
  left join lateral (
    select tp.paid_on, tp.amount from public.tenant_payments tp
    where tp.tenant_id = t.id order by tp.paid_on desc, tp.created_at desc limit 1
  ) p on true
  order by b.next_due_on nulls last, t.name;
end;
$$;

create or replace function public.platform_set_billing(p_tenant_id uuid, p_monthly_fee numeric, p_next_due_on date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_monthly_fee is null or p_monthly_fee < 0 then
    raise exception 'Enter a monthly fee of 0 or more' using errcode = '22023';
  end if;
  update public.tenant_billing set monthly_fee = p_monthly_fee, next_due_on = p_next_due_on where tenant_id = p_tenant_id;
  if not found then
    raise exception 'Tenant not found' using errcode = '22023';
  end if;
end;
$$;

-- Record a payment and move the next due date on by the months it covers.
create or replace function public.platform_record_payment(
  p_tenant_id uuid,
  p_amount numeric,
  p_paid_on date default null,
  p_months integer default 1,
  p_reference text default null
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due date;
  v_next date;
begin
  if not app.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 0 or coalesce(p_months, 0) not between 1 and 24 then
    raise exception 'Enter the amount paid and 1 to 24 months' using errcode = '22023';
  end if;
  select b.next_due_on into v_due from public.tenant_billing b where b.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'Tenant not found' using errcode = '22023';
  end if;
  if v_due is null then
    raise exception 'Set the next due date first' using errcode = '22023';
  end if;
  insert into public.tenant_payments (tenant_id, amount, paid_on, due_on, months, reference, recorded_by)
  values (p_tenant_id, p_amount, coalesce(p_paid_on, app.billing_today()), v_due, p_months, nullif(trim(p_reference), ''), auth.uid());
  v_next := (v_due + make_interval(months => p_months))::date;
  update public.tenant_billing set next_due_on = v_next where tenant_id = p_tenant_id;
  return v_next;
end;
$$;

create or replace function public.platform_tenant_payments(p_tenant_id uuid)
returns table (id uuid, amount numeric, paid_on date, due_on date, months integer, reference text)
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
  select tp.id, tp.amount, tp.paid_on, tp.due_on, tp.months, tp.reference
  from public.tenant_payments tp where tp.tenant_id = p_tenant_id
  order by tp.paid_on desc, tp.created_at desc limit 60;
end;
$$;

-- Delete a company and everything in it. It cannot be undone, so the
-- company must be suspended first and its web name typed to confirm.
-- Sign-in accounts stay: a person can belong to other companies and other
-- KaiTech products.
create or replace function public.platform_delete_tenant(p_tenant_id uuid, p_confirm_slug text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text;
  v_status public.tenant_status;
begin
  if not app.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select t.slug, t.status into v_slug, v_status from public.tenants t where t.id = p_tenant_id for update;
  if not found then
    raise exception 'Tenant not found' using errcode = '22023';
  end if;
  if v_status <> 'suspended' then
    raise exception 'Suspend the company before deleting it' using errcode = '22023';
  end if;
  if lower(trim(coalesce(p_confirm_slug, ''))) <> v_slug then
    raise exception 'The web name does not match' using errcode = '22023';
  end if;
  delete from public.tenants where id = p_tenant_id;
end;
$$;

revoke all on function app.tenants_add_billing(), app.billing_today() from public;
grant execute on function app.billing_today() to service_role;
revoke all on function
  public.platform_billing(),
  public.platform_set_billing(uuid, numeric, date),
  public.platform_record_payment(uuid, numeric, date, integer, text),
  public.platform_tenant_payments(uuid),
  public.platform_delete_tenant(uuid, text)
  from public, anon;
grant execute on function
  public.platform_billing(),
  public.platform_set_billing(uuid, numeric, date),
  public.platform_record_payment(uuid, numeric, date, integer, text),
  public.platform_tenant_payments(uuid),
  public.platform_delete_tenant(uuid, text)
  to authenticated, service_role;
