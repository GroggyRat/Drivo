# Data model

Postgres with PostGIS on Supabase. Migrations are in `supabase/migrations/`:

| File | Contents |
|---|---|
| `*_schema.sql` | Types, tables, indexes, data rules (triggers) |
| `*_rls.sql` | Access helpers, grants, Row Level Security policies, guards |
| `*_functions.sql` | Location pins and review, nearby search, speed limit lookup, acknowledging speed alerts |
| `*_platform.sql` | Platform owner functions (counts only) |
| `*_storage.sql` | Private buckets for location photos and proof of delivery |

## Rules every table follows

- Every tenant-owned row has `tenant_id`. Only `tenants` and `platform_admins` do not.
- Child rows reference parents by `(id, tenant_id)`. A row cannot point at another tenant's row, even from a buggy server call using the service role. Tests prove this.
- Points are `geography(Point, 4326)`, longitude -180 to 180. Distances and `ST_DWithin` are in metres and work across the 180 degree meridian.
- Records are deactivated, not deleted, when history refers to them (people, vehicles, depots).

## Tables

| Table | What it holds | Notes |
|---|---|---|
| `tenants` | One row per distribution company | `slug` for the branded sign-in page; `status` active or suspended; optional BillZilla and KaiWorkforce links |
| `platform_admins` | KaiTech staff who run the platform | No tenant; sees no tenant rows |
| `memberships` | A person's role in a tenant (owner, admin, dispatcher, driver) | One per person per tenant; one active Owner; `kaiworkforce_employee_id` for clock-in webhooks |
| `tenant_settings` | Speed limits, alert rules, fuel price, idle allowance, arrival and duplicate radius | Created automatically with the tenant |
| `speed_zones` | Urban areas as polygons, with an optional own limit | See "Speed limits" below |
| `depots` | Where routes start | |
| `locations` | Shops, depots, fuel stops and hazards on the map | pending, approved or rejected; hazards can expire; written only through functions |
| `customers` | Who goods are delivered to | Mirrored from BillZilla or added in Drivo; `location_id` links to one approved shop; several customers can share a shop |
| `vehicles` | Plate, model, fuel type, L/100 km, capacity | |
| `orders` | What to deliver: BillZilla invoices, manual and CSV orders | `source` says which; line items as JSON; `delivery_status` |
| `routes` | A planned run for one day | draft, sent, in progress, completed, cancelled; cannot leave draft without a driver and a vehicle |
| `route_stops` | Ordered stops on a route | Must be at an approved, non-hazard location; an order's stop must be at its customer's location; sequence is unique per route but can be swapped in one transaction |
| `proofs_of_delivery` | Photo, signature, received by, delivered in full or partial notes | One per stop; partial deliveries need notes |
| `shifts` | When a driver is tracked | Opened by KaiWorkforce clock-in or route start; one open shift per driver |
| `gps_batches` | Raw points, one row per upload | Id made on the phone so retries are not stored twice; deleted after archiving |
| `trips` | A driver's day: simplified line, distance, time moving and idle, top speed, link to the raw archive in R2 | One per driver per day |
| `speed_events` | Over the limit for longer than the tenant's threshold | Acknowledged by a manager |
| `segment_speeds` | Average speed per OSM way, direction, weekday and hour | Source for Valhalla historical traffic later |

### `gps_batches.points`

An array of `[epoch_ms, lon, lat, accuracy_m, speed_mps, heading_deg]`. Postgres compresses the column on disk. Up to 2,000 points per batch.

## Who can do what

| | Owner, Admin | Dispatcher | Driver |
|---|---|---|---|
| Tenant details, settings, speed zones, vehicles, depots | Read and change | Read | Read |
| People | Change roles and deactivate (only the Owner changes the Owner; nobody changes their own role) | Read | Own row |
| Locations | Read all, add (approved at once), approve, reject, edit | Read all, add (pending) | Approved ones (not expired hazards) and own pins, add (pending) |
| Customers, orders | Read, add and change manual ones; link customers to shops | Same | Only those on routes sent to them |
| Routes and stops | Plan, change, delete drafts | Same | Read routes sent to them |
| Proof of delivery, shifts, trips, speed events | Read | Read, acknowledge speed alerts | Own |
| GPS batches | Read | Read | Upload and read own |

BillZilla customers and invoices can be read and linked but not created or edited by people; they come from BillZilla.

Platform owners cannot read any of the above. They use `platform_list_tenants`, `platform_create_tenant`, `platform_set_tenant_status` and `platform_link_tenant`.

A suspended tenant's people see nothing and cannot upload, through the same helpers every policy uses. Nothing is deleted.

## Functions the apps call

| Function | Who | What |
|---|---|---|
| `submit_location(tenant, name, type, lon, lat, accuracy, directions, photo_path, address, expires_at)` | Any member | Adds a pin. Returns the id, status and any locations within the duplicate radius (default 30 m). Refuses fixes worse than 30 m. |
| `nearby_locations(tenant, lon, lat, radius)` | Any member | Locations near a point, nearest first, limited to what the caller can see |
| `review_location(location, approve, reason, customer_ids)` | Owner, Admin | Approve (and link customers) or reject |
| `update_location(location, ...)` | Owner, Admin | Edit name, type, position, directions, expiry |
| `speed_limit_at(tenant, lon, lat)` | Any member | Limit and zone name at a point |
| `acknowledge_speed_event(event)` | Owner, Admin, Dispatcher | Marks an alert as seen |

## Speed limits

Inside an active speed zone, the zone's own limit applies, or the tenant's urban limit (default 50 km/h) when the zone has none. Where zones overlap, the lowest limit wins. Outside every zone, the tenant's highway limit applies (default 80 km/h). A speed event is recorded when a driver is over the limit by more than the tolerance for longer than `speed_alert_after_s` (default 10 seconds).

## Fuel estimate

`distance_km x vehicle L/100 km / 100 + idle_fuel_l_per_stop x stops`. The fuel price per litre turns that into a cost. Both values are in `tenant_settings`.

## Indexes

GiST on every geography column (`locations.point`, `depots.point`, `speed_zones.area`). B-tree on `tenant_id` with status or date for the common lists (`orders`, `locations`, `routes`, `speed_events`, `gps_batches`), on foreign keys used in joins, and partial indexes for open shifts, unacknowledged alerts and unarchived batches.

## Storage

Private buckets `location-photos` and `delivery-proofs`. Every path starts with the tenant id (`<tenant_id>/...`). Members read and upload only inside their own tenants' folders. Pages show photos through short-lived signed URLs.
