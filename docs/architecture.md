# Architecture

## Components

| Component | Technology | Hosting |
|---|---|---|
| Admin web | Next.js (App Router, TypeScript), Tailwind CSS, MapLibre GL JS | Vercel |
| Backend | Supabase: Postgres with PostGIS, Auth, Realtime, Storage, Edge Functions | Supabase (own project) |
| Driver app | Kotlin, Jetpack Compose, MapLibre Android, Ferrostar, FusedLocationProvider, Room, WorkManager | Google Play (Android first) |
| Routing server | Valhalla (routing, matrices, turn-by-turn, map matching) and VROOM (stop order), behind a small authenticated API | Linux VPS, Docker Compose |
| Map tiles | Fiji Protomaps extract (PMTiles) | Cloudflare R2; OpenFreeMap tiles during development only |
| Raw GPS archive | Compressed daily files | Cloudflare R2 |

## How data flows

1. **Orders arrive.** BillZilla sends an HMAC-signed webhook when an invoice is confirmed, or a dispatcher clicks "Sync from BillZilla". Tenants without BillZilla add orders by hand or CSV. Orders whose customer has an approved location are "Ready for delivery".
2. **Plan.** The admin picks orders, a depot, a departure time and what to optimise for. The backend asks the routing API for a Valhalla matrix and three VROOM solutions (lowest fuel, fastest, shortest), with time, distance and fuel estimates.
3. **Send.** The route is assigned to a driver and a vehicle and sent. The driver app downloads the day's routes and caches map tiles at shift start.
4. **Drive.** Ferrostar navigates with Valhalla directions. The phone samples GPS, filters bad fixes, broadcasts live positions to the tenant's Realtime channel and uploads batches every 30 to 60 seconds.
5. **Deliver.** Arrival is detected by a geofence (default 50 m). The driver records proof of delivery. Drivo pushes the status back to BillZilla.
6. **Overnight.** Each driver's day becomes one `trips` row (map-matched, simplified line and totals). Raw points go to R2. Average speeds per road segment and hour update `segment_speeds`.

## Provider interfaces

Map, tile and routing calls go through our own interfaces so providers can be swapped:

- `MapProvider` (web and Android): style URL, tile source, attribution.
- `RoutingProvider` (backend): `matrix`, `optimise`, `route`, `mapMatch`. The first implementation calls our routing API; a mock is used in tests.

The routing API is only called by our backend (Edge Functions and the Next.js server), never directly by browsers or phones, except for Ferrostar's route requests, which go through the backend so the API key stays secret.

## Location tracking

- Android foreground service while on shift. FusedLocationProvider at `PRIORITY_HIGH_ACCURACY`.
- Every 3 to 5 seconds while moving, every 30 to 60 seconds when stationary.
- Fixes with reported accuracy worse than 30 m are dropped, and so are fixes that imply an impossible jump in speed.
- Points are buffered in Room and uploaded in batches by WorkManager. Upload ids are made on the phone, so a retry is not stored twice. Offline points sync when signal returns.
- Live positions go through Supabase Realtime Broadcast, one channel per tenant, not as database rows.
- Tracking only runs during a shift: KaiWorkforce clock-in to clock-out, or (without KaiWorkforce) route start to last stop.

## The 180 degree meridian

Fiji crosses the 180 degree meridian: Taveuni is cut by it, and most of the Lau Group lies east of it. Coordinates are stored with longitude between -180 and 180, as `geography`, which measures across the line correctly. The database tests check a Taveuni distance across the line, the duplicate check across it, and a Suva to Lakeba route line. Map views must wrap correctly: the admin map will use MapLibre's `renderWorldCopies` and fit bounds that cross the line, and this will be tested with the Taveuni and Lakeba demo shops from Milestone 3.

## Security

- RLS on every table, enforced through a small set of helper functions. See `docs/data-model.md`.
- The service role key is used only on the server: webhooks, creating sign-in accounts, the nightly jobs and signing photo URLs.
- Webhooks are HMAC-signed with a per-tenant secret and replay-protected (see `docs/integrations.md`).
