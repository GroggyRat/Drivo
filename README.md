# Drivo

Delivery routing and fleet tracking for distribution companies in Fiji, by KaiTech.

Dispatchers plan delivery routes from confirmed invoices, send them to drivers, and watch vehicles live. Drivers navigate inside the Drivo app, record proof of delivery and drop pins for new shops. Drivo works on its own, and connects to BillZilla (invoicing) and KaiWorkforce (HR and clock-in) when a tenant uses them.

All maps, routing and navigation run on our own open-source stack: MapLibre, Valhalla, VROOM, Ferrostar and Protomaps tiles. There are no Google Maps or paid map APIs.

## Repository

| Folder | What it holds | Status |
|---|---|---|
| `supabase/` | Postgres and PostGIS schema, Row Level Security, functions, storage, seed data, and the database tests | Milestone 1 |
| `routing/` | Docker Compose for Valhalla and VROOM with the Fiji OSM extract, the routing API, and the monthly rebuild | Milestone 2 |
| `web/` | Admin web app (Next.js, Tailwind CSS, MapLibre GL JS), hosted on Vercel | Milestone 3 |
| `android/` | Driver app (Kotlin, Jetpack Compose, MapLibre, Ferrostar) | Milestone 5 |
| `docs/` | Architecture, data model, integrations, decisions | Ongoing |

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

1. Repo structure, schema, RLS and tests, demo seed data. **Done.**
2. Routing server: Valhalla and VROOM with the Fiji extract, API wrapper, rebuild script.
3. Admin web: auth, layout, Locations, Vehicles, Settings.
4. Plan route and Review route with fuel estimates.
5. Driver app: sign in, Today's run, background tracking, offline queue, Realtime broadcast.
6. Live operations dashboard with live vehicles and speed alerts.
7. In-app navigation, arrival detection, proof of delivery, Drop a pin, Day ledger.
8. BillZilla and KaiWorkforce integrations, single sign-on, Deliveries ledger, CSV export.
9. Nightly trip compression, R2 archiving, historical speed aggregation, hardening.
