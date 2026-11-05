# Decisions and assumptions

Agreed before Milestone 1. Change this file when a decision changes.

## Product

| Topic | Decision |
|---|---|
| Sign-in | Drivo has its own sign-in (Supabase Auth, email and password or code). A tenant does not need BillZilla or KaiWorkforce to use Drivo. Single sign-on with a KaiTech account is optional and added on top in Milestone 8. |
| KaiWorkforce today | KaiWorkforce (the Kai-Tech repository, "Fiji HR and Payroll System") is a web app on Firebase Auth and Firestore. A native KaiWorkforce Android app is planned. |
| Driver app | Native Android from the start (Kotlin, Compose). iOS follows. |
| "Continue as" on Android | Now: sign in through a Chrome Custom Tab, which shares the browser's KaiTech session, so a driver already signed in to KaiWorkforce on the web can continue without a password. Later, when KaiWorkforce has a native app: Android AccountManager with a shared KaiTech account type, limited to apps signed with the KaiTech key, handing Drivo a short-lived one-time code to exchange for its own session (never sharing refresh tokens). The full design will be written up before Milestone 8. |
| Supabase | Drivo has its own Supabase project. Products talk through webhooks and APIs. |
| Linking products | `tenants.billzilla_org_id`, `tenants.kaiworkforce_company_id` and `memberships.kaiworkforce_employee_id`. Webhooks find records by these ids. Only the platform can set the tenant-level ids. |
| Tenants without BillZilla | Dispatchers add orders by hand or CSV import. BillZilla invoices and manual orders share the `orders` table, marked by `source`. |
| Tracking without KaiWorkforce | Tracking runs from when the driver starts a route until the last stop is done (`shifts.source = 'route'`). With KaiWorkforce, clock-in and clock-out start and stop it (`'kaiworkforce'`). |
| Customers and locations | A `customers` table, mirrored from BillZilla or added by hand. Each customer delivers to one approved shop; one shop can serve several customers (two accounts at the same address). The link lives on `customers.location_id`, not on `locations`. |
| Speed zones | Polygons per tenant (`speed_zones`). Inside a zone: the zone's limit, or the tenant's urban limit (default 50). Outside every zone: the highway limit (default 80). Overlapping zones use the lowest limit. OSM `maxspeed` from Valhalla can refine this later. |
| GPS storage | One `gps_batches` row per upload (about 30 to 60 seconds of points), never one row per point. Live positions go through Realtime Broadcast. The nightly job writes one `trips` row per driver per day, archives the raw points to R2 and deletes the batches. |

## Technical assumptions

- Conventions follow KaiInspect: RLS through a small set of helper functions, composite `(id, tenant_id)` foreign keys, `platform_admins` with count-only `platform_*` functions, suspension enforced in one helper, and database tests against a throwaway Postgres.
- A person can belong to several tenants (one membership each) and picks which one to work in. Each tenant has one active Owner.
- Drivers see approved locations and their own pins; other drivers' pending pins are hidden. Rejected pins are kept for the record.
- Admin and Owner pins are approved at once; driver and dispatcher pins wait for review. Dispatchers can view the review queue; only Owners and Admins approve.
- Pins need a GPS fix within 30 m (hazards excepted). The duplicate warning radius is 30 m, set per tenant.
- Time zone `Pacific/Fiji`, currency FJD, dates DD/MM/YYYY.
- Map data is OpenStreetMap (ODbL): every map shows "© OpenStreetMap contributors". Valhalla, VROOM, Ferrostar, MapLibre and Protomaps are permissively licensed.
