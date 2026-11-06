-- Plain coordinates and GeoJSON for the apps. PostgREST returns PostGIS
-- geography as hex, so these stored generated columns give the web and
-- driver apps longitude, latitude and GeoJSON lines directly. They are
-- computed by Postgres, cannot be written, and sit under the same RLS as
-- the row.

alter table public.locations
  add column lon double precision generated always as (extensions.st_x(point::extensions.geometry)) stored,
  add column lat double precision generated always as (extensions.st_y(point::extensions.geometry)) stored;

alter table public.depots
  add column lon double precision generated always as (extensions.st_x(point::extensions.geometry)) stored,
  add column lat double precision generated always as (extensions.st_y(point::extensions.geometry)) stored;

alter table public.driver_positions
  add column lon double precision generated always as (extensions.st_x(point::extensions.geometry)) stored,
  add column lat double precision generated always as (extensions.st_y(point::extensions.geometry)) stored;

alter table public.speed_events
  add column lon double precision generated always as (extensions.st_x(point::extensions.geometry)) stored,
  add column lat double precision generated always as (extensions.st_y(point::extensions.geometry)) stored;

alter table public.proofs_of_delivery
  add column lon double precision generated always as (extensions.st_x(point::extensions.geometry)) stored,
  add column lat double precision generated always as (extensions.st_y(point::extensions.geometry)) stored;

alter table public.routes
  add column geometry_geojson jsonb generated always as (extensions.st_asgeojson(geometry, 6)::jsonb) stored;

alter table public.trips
  add column geometry_geojson jsonb generated always as (extensions.st_asgeojson(geometry, 6)::jsonb) stored;

alter table public.speed_zones
  add column area_geojson jsonb generated always as (extensions.st_asgeojson(area, 6)::jsonb) stored;
