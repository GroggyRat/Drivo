# Drivo routing server

> **Routing now runs inside the web app on Vercel by default**, on Drivo's own Fiji road graph (`web/data/fiji-roads.bin`, router in `web/src/lib/routing/graph.ts`). It plans the three options, orders the stops, draws the road line and gives the driver app turn-by-turn directions. Nothing in this folder needs to be hosted for that.
>
> Rebuild the graph when the map data changes (monthly is plenty), then commit the new file:
>
> ```bash
> python3 scripts/routing/build-graph.py fiji-latest.osm.pbf web/data/fiji-roads.bin
> ```
>
> The Valhalla and VROOM server below is optional. Set `ROUTING_API_URL` and `ROUTING_API_KEY` in the web app to use it instead, for example for truck restrictions or map matching in the nightly job.

Valhalla and VROOM on a small Linux VPS, with Docker Compose, behind a thin authenticated API. Everything here is open source: no Google Maps and no paid map APIs.

| Service | What it does |
|---|---|
| `valhalla` | Road routing, travel time matrices, turn-by-turn instructions (for Ferrostar in the driver app) and map matching, from the Fiji OpenStreetMap extract |
| `vroom` | Stop order optimisation, using matrices from Valhalla |
| `api` | The only published service. Checks the bearer key and turns Drivo's requests into Valhalla and VROOM calls (`api/src`) |
| `caddy` | TLS certificates and HTTPS for the API |

## API

Every endpoint except `GET /health` needs `Authorization: Bearer <ROUTING_API_KEY>`. Only the Drivo backend holds the key; browsers and phones never call this server directly. The driver app reaches navigation through the Drivo backend, which checks the driver's sign-in first.

| Endpoint | Request | Response |
|---|---|---|
| `POST /v1/plan` | depot, stops (id, position, service seconds, cartons), departure time, vehicle capacity and L/100 km, objectives | One option per objective: stop order, legs, distance, time, arrival times, road line |
| `POST /v1/sequence` | Same, with stops in a fixed order and one objective | One option, for a dispatcher's manual reorder |
| `POST /v1/navigation/route` | Ferrostar's Valhalla request | Valhalla route in OSRM format with banner and voice instructions |
| `POST /v1/map-match` | GPS points (lon, lat, unix time) | Road-snapped line, and length and speed per OSM way |
| `GET /health` | | 200 when Valhalla is serving |

The request and response shapes match `web/src/lib/routing/types.ts`.

### How the three options differ

VROOM minimises a cost matrix built from Valhalla's times and distances:

- **Fastest**: travel time in seconds.
- **Shortest**: distance in metres.
- **Lowest fuel**: millilitres of fuel, which is distance x the vehicle's L/100 km plus idling at about 1 L per hour for the travel time. This prefers routes that avoid slow, congested stretches even when they are a little longer.

Valhalla then draws the road line for each order. The costing is `truck` by default (set `COSTING=auto` for vans).

## Install on a VPS

Ubuntu 24.04, 2 vCPU and 4 GB RAM is plenty for Fiji.

```bash
sudo apt-get install -y docker.io docker-compose-v2 curl
```

```bash
sudo mkdir -p /opt/drivo && sudo chown "$USER" /opt/drivo && git clone <this repository> /opt/drivo
```

```bash
cd /opt/drivo/routing && cp .env.example .env
```

Edit `.env`: set `ROUTING_API_KEY` to a long random value (`openssl rand -hex 32`) and `ROUTING_DOMAIN` to the server's DNS name. Then download Fiji and build the tiles (a few minutes):

```bash
scripts/update-osm.sh
```

```bash
docker compose up -d
```

Give the web app `ROUTING_API_URL=https://<ROUTING_DOMAIN>` and the same `ROUTING_API_KEY`.

## Monthly data update

`scripts/update-osm.sh` downloads `fiji-latest.osm.pbf` from Geofabrik, checks its MD5, refuses suspiciously small files, rebuilds the tiles only when the extract changed, and restarts Valhalla and VROOM. Install the timer to run it monthly:

```bash
sudo cp ops/drivo-osm-update.service ops/drivo-osm-update.timer /etc/systemd/system/
```

```bash
sudo systemctl enable --now drivo-osm-update.timer
```

## Tests

```bash
cd api && npm install
```

```bash
npm test
```

The tests run the API against fake Valhalla and VROOM responses: key checks, validation, the three cost matrices, capacity, fixed order, navigation pass-through, map matching, and polyline encoding across the 180 degree meridian.

## The 180 degree meridian

Valhalla does not join roads across the 180 degree meridian, which runs through Taveuni. The API handles it: when two points are on opposite sides and Valhalla finds no path, it finds where roads cross the meridian (once, by snapping points on both sides of the line) and routes through the fastest crossing. Checked with the real Fiji extract: Waiyevo to Matei routes along the Taveuni coast road.

Islands with no road between them (for example Suva and Lakeba in the Lau Group) cannot share a truck route: the API answers with a plain message asking for one route per island.

## Checked with real data

Built from the Geofabrik Fiji extract of 04/11/2026 (131 tiles): Walu Bay to Nausori is 19.1 km and 23 minutes by road, a four-stop Suva plan returns road lines for all three options, and Taveuni across the meridian works. Valhalla's time-zone build needs to download world boundaries from GitHub on the VPS; Fiji is one time zone, so building with `build_time_zones=False` is also fine.
