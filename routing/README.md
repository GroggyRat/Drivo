# Drivo routing server

Docker Compose on a small Linux VPS. Built in Milestone 2.

- Valhalla with the Fiji OpenStreetMap extract from Geofabrik: routing, travel time matrices, turn-by-turn instructions and map matching.
- VROOM for stop-order optimisation, using Valhalla.
- A thin authenticated API in front of both. Only the Drivo backend may call it.
- A monthly job that downloads fresh Fiji OSM data and rebuilds the Valhalla tiles.

Downloaded extracts and built tiles go in `routing/data/`, which is not committed.
