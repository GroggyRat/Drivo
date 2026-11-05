-- Local demo data. `supabase db reset` runs this after the migrations.
-- Never run it against production.
--
-- Every account below signs in locally with the password: DrivoDemo2026
--   owner@nadera.test       Asha Nadera, Owner of Nadera Distributors
--   admin@nadera.test       Mere Tuilau, Admin
--   dispatch@nadera.test    Rohit Prasad, Dispatcher
--   driver1@nadera.test     Jone Vakacegu, Driver (has a route sent for today)
--   driver2@nadera.test     Salote Naivalu, Driver (draft route for tomorrow)
--   driver3@nadera.test     Vikash Kumar, Driver
--   admin@western.test      Admin of a second tenant, Western Wholesale (Lautoka)
--   driver@western.test     Driver of Western Wholesale
--   platform@kaitech.test   KaiTech platform owner (manages tenants, sees no tenant data)
--
-- Coordinates are approximate and the shops are fictional. Taveuni and Lau
-- Group shops are included to exercise the 180 degree meridian early.
-- Fuel price is a demo value, not a real pump price.

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
insert into public.tenants (id, name, slug, contact_email, billzilla_enabled, billzilla_org_id, kaiworkforce_enabled, kaiworkforce_company_id)
values
  ('10000000-0000-4000-8000-000000000001', 'Nadera Distributors', 'nadera', 'owner@nadera.test', true, 'bz-demo-nadera', true, 'kw-demo-nadera'),
  ('10000000-0000-4000-8000-000000000002', 'Western Wholesale', 'western-wholesale', 'admin@western.test', false, null, false, null);

update public.tenant_settings set fuel_price_per_l = 2.950 where tenant_id = '10000000-0000-4000-8000-000000000001';
update public.tenant_settings set fuel_price_per_l = 2.950 where tenant_id = '10000000-0000-4000-8000-000000000002';

-- ---------------------------------------------------------------------------
-- Sign-in accounts and memberships
-- ---------------------------------------------------------------------------
do $$
declare
  u record;
begin
  for u in
    select * from (values
      ('20000000-0000-4000-8000-000000000001'::uuid, 'owner@nadera.test'),
      ('20000000-0000-4000-8000-000000000002'::uuid, 'admin@nadera.test'),
      ('20000000-0000-4000-8000-000000000003'::uuid, 'dispatch@nadera.test'),
      ('20000000-0000-4000-8000-000000000004'::uuid, 'driver1@nadera.test'),
      ('20000000-0000-4000-8000-000000000005'::uuid, 'driver2@nadera.test'),
      ('20000000-0000-4000-8000-000000000006'::uuid, 'driver3@nadera.test'),
      ('20000000-0000-4000-8000-000000000011'::uuid, 'admin@western.test'),
      ('20000000-0000-4000-8000-000000000012'::uuid, 'driver@western.test'),
      ('20000000-0000-4000-8000-0000000000f1'::uuid, 'platform@kaitech.test')
    ) as t (id, email)
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
      extensions.crypt('DrivoDemo2026', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
    );
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), u.id::text, u.id,
      jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
      'email', now(), now(), now()
    );
  end loop;
end
$$;

insert into public.memberships (tenant_id, user_id, role, full_name, email, phone, kaiworkforce_employee_id)
values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'owner', 'Asha Nadera', 'owner@nadera.test', null, null),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'admin', 'Mere Tuilau', 'admin@nadera.test', null, null),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'dispatcher', 'Rohit Prasad', 'dispatch@nadera.test', null, null),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000004', 'driver', 'Jone Vakacegu', 'driver1@nadera.test', null, 'KW-EMP-1001'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000005', 'driver', 'Salote Naivalu', 'driver2@nadera.test', null, 'KW-EMP-1002'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000006', 'driver', 'Vikash Kumar', 'driver3@nadera.test', null, 'KW-EMP-1003'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000011', 'owner', 'Kalesi Waqa', 'admin@western.test', null, null),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000012', 'driver', 'Arun Lal', 'driver@western.test', null, null);

insert into public.platform_admins (user_id, full_name, email)
values ('20000000-0000-4000-8000-0000000000f1', 'KaiTech Platform', 'platform@kaitech.test');

-- ---------------------------------------------------------------------------
-- Nadera: depots, vehicles, speed zones
-- ---------------------------------------------------------------------------
insert into public.depots (id, tenant_id, name, address, point) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Walu Bay Depot', 'Walu Bay, Suva',
   extensions.st_makepoint(178.4335, -18.1262)::extensions.geography),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Nausori Depot', 'Kings Road, Nausori',
   extensions.st_makepoint(178.5345, -18.0302)::extensions.geography);

insert into public.vehicles (id, tenant_id, plate, model, fuel_type, fuel_l_per_100km, capacity_cartons) values
  ('31000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'FT 482', 'Isuzu NPR 4.5 t', 'diesel', 14.5, 300),
  ('31000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'FT 517', 'Hino 300', 'diesel', 13.2, 260),
  ('31000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'GA 103', 'Toyota Hiace van', 'diesel', 9.8, 120),
  ('31000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'HB 220', 'Mitsubishi Canter', 'diesel', 12.9, 240);

-- Urban limit inside these areas, highway limit (80) outside, for example on
-- Kings Road between Nakasi and Nausori.
insert into public.speed_zones (tenant_id, name, area) values
  ('10000000-0000-4000-8000-000000000001', 'Greater Suva and Nasinu',
   extensions.st_multi(extensions.st_makeenvelope(178.40, -18.17, 178.53, -18.07, 4326))::extensions.geography),
  ('10000000-0000-4000-8000-000000000001', 'Nausori Town',
   extensions.st_multi(extensions.st_makeenvelope(178.51, -18.045, 178.55, -18.015, 4326))::extensions.geography);

-- ---------------------------------------------------------------------------
-- Nadera: locations
-- ---------------------------------------------------------------------------
insert into public.locations (id, tenant_id, name, type, point, address, landmark_directions, accuracy_m, status, created_by, approved_by, approved_at, expires_at)
select
  l.id::uuid, '10000000-0000-4000-8000-000000000001', l.name, l.type::public.location_type,
  extensions.st_makepoint(l.lon, l.lat)::extensions.geography, l.address, l.directions, 6,
  'approved', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', now(),
  case when l.type = 'hazard' then now() + interval '14 days' end
from (values
  ('40000000-0000-4000-8000-000000000001', 'Cumming Street Mart', 'shop', 178.4258, -18.1398, 'Cumming Street, Suva', 'Blue shopfront opposite the bus shelter'),
  ('40000000-0000-4000-8000-000000000002', 'Marks Street Grocers', 'shop', 178.4255, -18.1380, 'Marks Street, Suva', 'Deliveries through the lane at the back'),
  ('40000000-0000-4000-8000-000000000003', 'Toorak Corner Store', 'shop', 178.4365, -18.1347, 'Toorak Road, Suva', 'Corner with the yellow awning'),
  ('40000000-0000-4000-8000-000000000004', 'Flagstaff Supermarket', 'shop', 178.4440, -18.1290, 'Flagstaff, Suva', 'Loading bay on the left side'),
  ('40000000-0000-4000-8000-000000000005', 'Nabua Family Store', 'shop', 178.4590, -18.1180, 'Nabua', 'Next to the church hall'),
  ('40000000-0000-4000-8000-000000000006', 'Nabua Market Canteen', 'shop', 178.4625, -18.1145, 'Nabua', 'Inside the market gate, first stall'),
  ('40000000-0000-4000-8000-000000000007', 'Samabula Mini Mart', 'shop', 178.4655, -18.1205, 'Samabula', 'Opposite the police post'),
  ('40000000-0000-4000-8000-000000000008', 'Samabula East Store', 'shop', 178.4700, -18.1230, 'Samabula East', 'Green building, park on the grass'),
  ('40000000-0000-4000-8000-000000000009', 'Raiwaqa Bakery', 'shop', 178.4585, -18.1265, 'Raiwaqa', 'Bakery entrance at the back'),
  ('40000000-0000-4000-8000-000000000010', 'Valelevu Supermarket', 'shop', 178.4880, -18.0905, 'Valelevu, Nasinu', 'Big car park, use the side door'),
  ('40000000-0000-4000-8000-000000000011', 'Nakasi Wholesale', 'shop', 178.5160, -18.0560, 'Nakasi', 'Behind the bus stop'),
  ('40000000-0000-4000-8000-000000000012', 'Nausori Main Street Store', 'shop', 178.5330, -18.0310, 'Main Street, Nausori', 'Two doors from the bank'),
  ('40000000-0000-4000-8000-000000000013', 'Nausori Market Grocers', 'shop', 178.5305, -18.0325, 'Nausori Market', 'Market side entrance'),
  ('40000000-0000-4000-8000-000000000014', 'Davuilevu Road Canteen', 'shop', 178.5195, -18.0230, 'Davuilevu Road, Nausori', 'Small canteen by the school gate'),
  ('40000000-0000-4000-8000-000000000015', 'Waiyevo General Store', 'shop', 179.9800, -16.7905, 'Waiyevo, Taveuni', 'West of the 180 degree line'),
  ('40000000-0000-4000-8000-000000000016', 'Matei Store', 'shop', -179.8850, -16.6905, 'Matei, Taveuni', 'East of the 180 degree line, near the airstrip'),
  ('40000000-0000-4000-8000-000000000017', 'Tubou Co-op', 'shop', -178.8040, -18.2330, 'Tubou, Lakeba, Lau Group', 'Goods arrive by boat'),
  ('40000000-0000-4000-8000-000000000018', 'Laucala Bay Road Fuel', 'fuel', 178.4520, -18.1395, 'Laucala Bay Road, Suva', null),
  ('40000000-0000-4000-8000-000000000019', 'Roadworks, Ratu Mara Road', 'hazard', 178.4640, -18.1170, 'Ratu Mara Road, Samabula', 'One lane only, expect delays')
) as l (id, name, type, lon, lat, address, directions);

-- Pins waiting for review. The second is about 15 m from Nabua Family Store,
-- so it shows the duplicate warning.
insert into public.locations (id, tenant_id, name, type, point, landmark_directions, accuracy_m, status, created_by) values
  ('40000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000001', 'Laqere Canteen', 'shop',
   extensions.st_makepoint(178.4950, -18.0610)::extensions.geography, 'Small canteen past the Laqere bridge', 7, 'pending',
   '20000000-0000-4000-8000-000000000004'),
  ('40000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000001', 'Nabua Family Shop', 'shop',
   extensions.st_makepoint(178.45905, -18.11812)::extensions.geography, 'Next to the church', 9, 'pending',
   '20000000-0000-4000-8000-000000000005');

-- ---------------------------------------------------------------------------
-- Nadera: customers (from BillZilla) and invoices ready for delivery
-- ---------------------------------------------------------------------------
insert into public.customers (id, tenant_id, source, billzilla_customer_id, name, phone, location_id)
select
  ('50000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  '10000000-0000-4000-8000-000000000001', 'billzilla', 'BZ-CUST-' || (2000 + n), l.name, null, l.id
from public.locations l
cross join lateral (select right(l.id::text, 2)::int as n) x
where l.tenant_id = '10000000-0000-4000-8000-000000000001' and l.type = 'shop' and l.status = 'approved';

-- A second account at the same shop, and two customers with no pin yet.
insert into public.customers (id, tenant_id, source, billzilla_customer_id, name, location_id) values
  ('50000000-0000-4000-8000-000000000051', '10000000-0000-4000-8000-000000000001', 'billzilla', 'BZ-CUST-2051',
   'Cumming Street Mart (Wholesale account)', '40000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000052', '10000000-0000-4000-8000-000000000001', 'billzilla', 'BZ-CUST-2052', 'Laqere Canteen', null),
  ('50000000-0000-4000-8000-000000000053', '10000000-0000-4000-8000-000000000001', 'billzilla', 'BZ-CUST-2053', 'Kalabu Corner Shop', null);

insert into public.orders (tenant_id, source, billzilla_invoice_id, reference, customer_id, customer_name, cartons, line_items, total_amount, billzilla_status, confirmed_at)
select
  c.tenant_id, 'billzilla', 'bz-inv-' || (10230 + rn), 'INV-' || (10230 + rn), c.id, c.name,
  4 + (rn * 7) % 23,
  jsonb_build_array(
    jsonb_build_object('sku', 'RICE-10', 'description', 'Rice 10 kg', 'quantity', 2 + rn % 5, 'unit', 'bag'),
    jsonb_build_object('sku', 'FLOUR-10', 'description', 'Flour 10 kg', 'quantity', 1 + rn % 4, 'unit', 'bag'),
    jsonb_build_object('sku', 'TINFISH-24', 'description', 'Tinned fish, carton of 24', 'quantity', 1 + rn % 3, 'unit', 'carton')
  ),
  round((180 + rn * 37.5)::numeric, 2), 'confirmed', now() - interval '1 day'
from (
  select c.*, row_number() over (order by c.billzilla_customer_id) as rn
  from public.customers c
  where c.tenant_id = '10000000-0000-4000-8000-000000000001'
) c;

-- ---------------------------------------------------------------------------
-- Nadera: today's route for Jone (sent) and tomorrow's draft for Salote
-- ---------------------------------------------------------------------------
insert into public.routes (id, tenant_id, name, route_date, depot_id, status, optimise_for, departure_at, driver_id, vehicle_id,
  planned_distance_m, planned_duration_s, fuel_estimate_l, created_by, sent_at)
values
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Suva CBD and Toorak',
   (now() at time zone 'Pacific/Fiji')::date, '30000000-0000-4000-8000-000000000001', 'sent', 'lowest_fuel',
   date_trunc('day', now() at time zone 'Pacific/Fiji') at time zone 'Pacific/Fiji' + interval '8 hours',
   '20000000-0000-4000-8000-000000000004', '31000000-0000-4000-8000-000000000001',
   9800, 3600, 1.82, '20000000-0000-4000-8000-000000000003', now()),
  ('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Nabua and Samabula',
   (now() at time zone 'Pacific/Fiji')::date + 1, '30000000-0000-4000-8000-000000000001', 'draft', 'fastest',
   null, '20000000-0000-4000-8000-000000000005', '31000000-0000-4000-8000-000000000002',
   null, null, null, '20000000-0000-4000-8000-000000000003', null);

insert into public.route_stops (tenant_id, route_id, sequence, location_id, order_id)
select '10000000-0000-4000-8000-000000000001', r.route_id, r.seq, c.location_id, o.id
from (values
  ('60000000-0000-4000-8000-000000000001'::uuid, 1, '50000000-0000-4000-8000-000000000003'::uuid),
  ('60000000-0000-4000-8000-000000000001'::uuid, 2, '50000000-0000-4000-8000-000000000004'::uuid),
  ('60000000-0000-4000-8000-000000000001'::uuid, 3, '50000000-0000-4000-8000-000000000001'::uuid),
  ('60000000-0000-4000-8000-000000000001'::uuid, 4, '50000000-0000-4000-8000-000000000002'::uuid),
  ('60000000-0000-4000-8000-000000000002'::uuid, 1, '50000000-0000-4000-8000-000000000005'::uuid),
  ('60000000-0000-4000-8000-000000000002'::uuid, 2, '50000000-0000-4000-8000-000000000007'::uuid),
  ('60000000-0000-4000-8000-000000000002'::uuid, 3, '50000000-0000-4000-8000-000000000008'::uuid)
) as r (route_id, seq, customer_id)
join public.customers c on c.id = r.customer_id
join public.orders o on o.customer_id = c.id;

update public.orders set delivery_status = 'planned'
where id in (select order_id from public.route_stops where order_id is not null);

-- ---------------------------------------------------------------------------
-- Western Wholesale (Lautoka): no BillZilla or KaiWorkforce, manual orders
-- ---------------------------------------------------------------------------
insert into public.depots (id, tenant_id, name, address, point) values
  ('30000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000002', 'Lautoka Depot', 'Vitogo Parade, Lautoka',
   extensions.st_makepoint(177.4520, -17.6100)::extensions.geography);
insert into public.vehicles (tenant_id, plate, model, fuel_type, fuel_l_per_100km) values
  ('10000000-0000-4000-8000-000000000002', 'LT 900', 'Isuzu ELF', 'diesel', 13.8);
insert into public.speed_zones (tenant_id, name, area) values
  ('10000000-0000-4000-8000-000000000002', 'Lautoka City',
   extensions.st_multi(extensions.st_makeenvelope(177.42, -17.64, 177.48, -17.58, 4326))::extensions.geography);
insert into public.locations (id, tenant_id, name, type, point, status, created_by, approved_by, approved_at) values
  ('40000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000002', 'Namoli Store', 'shop',
   extensions.st_makepoint(177.4560, -17.6150)::extensions.geography, 'approved',
   '20000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000011', now());
insert into public.customers (id, tenant_id, source, name, location_id) values
  ('50000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000002', 'manual', 'Namoli Store',
   '40000000-0000-4000-8000-000000000101');
insert into public.orders (tenant_id, source, reference, customer_id, customer_name, cartons) values
  ('10000000-0000-4000-8000-000000000002', 'manual', 'WW-0001', '50000000-0000-4000-8000-000000000101', 'Namoli Store', 8);
