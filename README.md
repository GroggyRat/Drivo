# Drivo

Delivery routing and fleet tracking for distribution companies in Fiji, by KaiTech.

Dispatchers plan delivery routes from confirmed invoices, send them to drivers, and watch vehicles live. Drivers navigate inside the Drivo app, record proof of delivery and drop pins for new shops. Drivo works on its own, and connects to BillZilla (invoicing) and KaiWorkforce (HR and clock-in) when a tenant uses them.

All maps, routing and navigation run on our own open-source stack: MapLibre, Valhalla, VROOM, Ferrostar and Protomaps tiles. There are no Google Maps or paid map APIs.

## Repository

| Folder | What it holds |
|---|---|
| `supabase/` | Postgres and PostGIS schema, Row Level Security, functions, storage, seed data, and the database tests |
| `web/` | Admin web app (Next.js, Tailwind CSS, MapLibre GL JS), hosted on Vercel |
| `routing/` | Docker Compose for Valhalla and VROOM with the Fiji OSM extract, the routing API, and the monthly rebuild |
| `android/` | Driver app (Kotlin, Jetpack Compose, MapLibre, Ferrostar) |
| `jobs/` | Nightly job: GPS archive to R2, road matching, trips, road speeds |
| `scripts/dev/` | Local preview and the driver simulator |
| `docs/` | Architecture, data model, integrations, decisions |

## Local preview

Needs Docker and Node 22. Starts Supabase with the demo data, the admin app on http://localhost:3000, and a simulator that drives two Nadera drivers through their routes:

```bash
scripts/dev/preview.sh
```

Sign in as `admin@nadera.test` with the password `DrivoDemo2026`.

## Quick start (database)

You need Node 22 and either the Supabase CLI (with Docker) or a local Postgres with PostGIS.

Run the database and RLS tests. The script starts a throwaway Postgres; PostGIS must be installed (on Ubuntu, `postgresql-16-postgis-3`):

```bash
npm install
```

```bash
npm run test:db
```

Run a full local Supabase with the demo data:

```bash
npx supabase start
```

```bash
npx supabase db reset
```

The demo tenant is **Nadera Distributors**. Every demo account uses the password `DrivoDemo2026`; the accounts are listed at the top of `supabase/seed.sql`.

## Documentation

- [Architecture](docs/architecture.md): components, how data flows, provider interfaces, location tracking, and the 180 degree meridian
- [Data model](docs/data-model.md): every table, who can see and change what, and why
- [Integrations](docs/integrations.md): BillZilla and KaiWorkforce endpoints and payloads (draft until Milestone 8)
- [Decisions](docs/decisions.md): product decisions and assumptions agreed so far

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Repo, schema, RLS and tests, demo seed | Built and tested |
| 2 | Routing server: Valhalla, VROOM, API, monthly rebuild | API built and tested against mocks; not yet run with the live Fiji extract |
| 3 | Admin web: auth, layout, Locations, Vehicles, Settings | Built |
| 4 | Plan route and Review route with fuel estimates | Built; uses straight-line estimates until the routing server is connected |
| 5 | Driver app: sign in, Today's run, tracking, offline queue, Realtime | Written; tracking rules tested in `:core`, app not yet compiled (needs the Android SDK) |
| 6 | Live operations with live vehicles and speed alerts | Built |
| 7 | Navigation, arrival, proof of delivery, Drop a pin, Day ledger | Written in the Android app, not yet compiled |
| 8 | BillZilla and KaiWorkforce integrations, Deliveries ledger, CSV export | Webhooks, push-back outbox, sync and ledger built; single sign-on planned (see docs/decisions.md) |
| 9 | Nightly trips, R2 archive, road speeds, hardening | Job built and unit tested; not yet run against R2 |
