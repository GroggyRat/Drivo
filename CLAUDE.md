# Drivo

Multi-tenant delivery routing and fleet tracking for Fiji distribution companies. Monorepo: `supabase/` (database), `routing/` (Valhalla and VROOM), `web/` (Next.js admin), `android/` (Kotlin driver app), `docs/`. See README.md.

## Commands

- `npm run test:db` (database, RLS and seed tests against a throwaway Postgres with PostGIS), `npm run typecheck`.

## Rules for changes

- No Google Maps, no external navigation apps, no paid map APIs. Map, routing and tile calls go through our own interfaces (`MapProvider`, `RoutingProvider`) so providers can be swapped.
- Every tenant table has `tenant_id` and RLS. Child tables use composite `(id, tenant_id)` foreign keys. `tenants` and `platform_admins` are the only tables without `tenant_id`. Add tests in `supabase/tests/security.test.ts` for any new table or policy, and add the table to the fixture in `supabase/tests/fixtures.ts` so the isolation tests cover it.
- All access checks go through the helpers in `supabase/migrations/*_rls.sql` (`app.active_memberships`, `app.member_role`, `app.*_tenant_ids`). Suspension and deactivation are enforced there. In policies, wrap them as `tenant_id = any ((select app.member_tenant_ids())::uuid[])` so they run once per query.
- Trigger guards that should only apply to people check `auth.role() = 'authenticated'`, never `current_user` (inside a security definer function that is the owner).
- Locations are written only through `submit_location`, `review_location` and `update_location`. Driver progress and proof of delivery will go through functions too, not direct table writes.
- Integration ids that webhooks use to find a tenant (`billzilla_org_id`, `kaiworkforce_company_id`) are set only by `platform_link_tenant`.
- Xero: a tenant's Admin connects their own Xero organisation by OAuth. `xero_connections` (tokens encrypted by the web server, `xero_tenant_id` that webhooks use to find the tenant) is written only by the server; people see its name and last sync. Xero customers and invoices are written only by `xero_ingest` and are read-only in Drivo, like BillZilla ones. Drivo only reads from Xero. Tests in `supabase/tests/xero.test.ts` and `web/tests/lib.test.ts`.
- Platform owners manage tenants only through the `platform_*` functions, which return counts, never tenant content.
- Billing is a ledger the platform keeps (`tenant_billing`, `tenant_payments`): a monthly fee and the next due date, moved on by `platform_record_payment`. Drivo takes no money. A company is deleted only by `platform_delete_tenant`, which needs it suspended and its web name typed.
- Road alerts (hazards, police checkpoints, speed cameras) are a paid add-on, `tenants.road_alerts_enabled`, set only by `platform_set_road_alerts`. They stay inside the tenant: drivers read them through `road_alerts_near`, which never returns the reporter, and writes go through `report_road_alert` and `vote_road_alert`. Tests in `supabase/tests/road-alerts.test.ts`.
- Do not store one database row per GPS point. Phones upload batches (`gps_batches`); live positions go through Realtime Broadcast; the nightly job writes `trips` and archives raw points to R2.
- Points are `geography(Point, 4326)` with longitude from -180 to 180. Fiji crosses the 180 degree meridian: test anything spatial with Taveuni and the Lau Group.
- Design: IBM Plex Sans with tabular figures, no monospace; navy #0B1F44, blue #2563EB, text #0B1220, secondary #5D6B82, borders #E4E7EC, background #F7F8FA. Black primary buttons, white secondary buttons with a 1px border. Radius 8 to 10px, no heavy shadows, no gradients, no emoji, no em dashes in copy, no celebratory microcopy. 4.5:1 contrast, 44px touch targets on mobile.
- Plain British English. Dates DD/MM/YYYY in the tenant's time zone (default Pacific/Fiji). Currency FJD.
