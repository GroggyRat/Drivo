// Drives the demo tenant for local development and previews. It plays the
// part of the Android app for two Nadera drivers, against a local Supabase
// started with `npx supabase start` (demo seed data):
//
//   1. As the dispatcher, plans and sends a Nausori route to Vikash for today.
//   2. As each driver, starts the route and back-fills the morning: GPS
//      batches every minute (one stretch over the speed limit), and
//      deliveries completed with a photo and a signature.
//   3. Keeps driving: broadcasts a live position every 3 seconds on the
//      tenant's Realtime channel, uploads a GPS batch every 15 seconds and
//      completes each stop on arrival.
//
//   node scripts/dev/simulate-drivers.mjs            (back-fill, then keep driving)
//   node scripts/dev/simulate-drivers.mjs --once     (back-fill only)
//
// Never point this at production: it signs in with the demo passwords.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { demoPhoto, demoSignature } from "./png.mjs";

const env = Object.fromEntries(
  execSync("npx supabase status -o env", { encoding: "utf8" })
    .split("\n")
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const URL = env.API_URL;
const ANON = env.ANON_KEY;
if (!URL || !ANON) throw new Error("Start Supabase first: npx supabase start");
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(URL)) throw new Error("Refusing to run against a non-local Supabase");

const TENANT = "10000000-0000-4000-8000-000000000001";
const PASSWORD = "DrivoDemo2026";
const ONCE = process.argv.includes("--once");
const KMH = 38;
const STEP_S = 4;

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const haversine = (a, b) => {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const bearing = (a, b) => {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (Math.atan2(y, x) * 180) / Math.PI + 360;
};
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Road paths from a local Valhalla (routing/docker-compose.local.yml). When
// Valhalla is not running, drivers move in straight lines instead.
const VALHALLA = process.env.VALHALLA_URL ?? "http://127.0.0.1:8002";
const decode6 = (str) => {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let r = 0, sh = 0, b;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
      const d = r & 1 ? ~(r >> 1) : r >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
};
let valhallaUp = null;
async function roadPath(from, to) {
  if (valhallaUp !== false) {
    try {
      const res = await fetch(`${VALHALLA}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locations: [{ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] }], costing: "truck", directions_type: "none" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        valhallaUp = true;
        const shape = decode6((await res.json()).trip.legs[0].shape);
        return [from, ...shape, to];
      }
    } catch {
      valhallaUp = false;
      console.log("Valhalla not reachable: drivers move in straight lines.");
    }
  }
  return [from, to];
}
const pathLength = (path) => path.slice(1).reduce((s, p, i) => s + haversine(path[i], p), 0);
/** Position and heading after `metres` along a path. */
function along(path, metres) {
  let left = metres;
  for (let i = 1; i < path.length; i++) {
    const seg = haversine(path[i - 1], path[i]);
    if (left <= seg && seg > 0) return { pos: lerp(path[i - 1], path[i], left / seg), heading: Math.round(bearing(path[i - 1], path[i]) % 360) };
    left -= seg;
  }
  const n = path.length;
  return { pos: path[n - 1], heading: n > 1 ? Math.round(bearing(path[n - 2], path[n - 1]) % 360) : 0 };
}

async function signIn(email) {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`${email}: ${error.message}`);
  return { client, userId: data.user.id };
}

const must = (label) => ({ data, error }) => {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
};

/** As the dispatcher: a Nausori run for Vikash today, unless one exists. */
async function ensureVikashRoute() {
  const { client } = await signIn("dispatch@nadera.test");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Fiji" }).format(new Date());
  const vikash = "20000000-0000-4000-8000-000000000006";
  const existing = await client.from("routes").select("id").eq("driver_id", vikash).eq("route_date", today).neq("status", "cancelled").then(must("routes"));
  if (existing.length) return existing[0].id;

  const depot = await client.from("depots").select("id, lon, lat").eq("name", "Nausori Depot").single().then(must("depot"));
  const orders = await client
    .from("orders")
    .select("id, customer:customers!inner(billzilla_customer_id, location:locations(id, lon, lat))")
    .in("customer.billzilla_customer_id", ["BZ-CUST-2011", "BZ-CUST-2014", "BZ-CUST-2013", "BZ-CUST-2012"])
    .eq("delivery_status", "ready")
    .then(must("orders"));
  const wanted = ["BZ-CUST-2011", "BZ-CUST-2014", "BZ-CUST-2013", "BZ-CUST-2012"];
  const stops = wanted.map((c) => orders.find((o) => o.customer.billzilla_customer_id === c)).filter(Boolean);
  const start = new Date();
  start.setMinutes(start.getMinutes() - 75);
  const points = [[depot.lon, depot.lat], ...stops.map((o) => [o.customer.location.lon, o.customer.location.lat]), [depot.lon, depot.lat]];
  let distance = 0;
  for (let i = 1; i < points.length; i++) distance += haversine(points[i - 1], points[i]) * 1.35;
  const id = await client
    .rpc("save_route", {
      p_tenant_id: TENANT,
      p_route: {
        name: "Nausori and Nakasi",
        route_date: today,
        depot_id: depot.id,
        optimise_for: "fastest",
        departure_at: start.toISOString(),
        driver_id: vikash,
        vehicle_id: "31000000-0000-4000-8000-000000000003",
        planned_distance_m: Math.round(distance),
        planned_duration_s: Math.round((distance / 1000 / KMH) * 3600 + stops.length * 420),
        fuel_estimate_l: Math.round(((distance / 1000) * 9.8) / 100 * 100 + stops.length * 10) / 100,
        geometry: { type: "LineString", coordinates: points },
        stops: stops.map((o) => ({ location_id: o.customer.location.id, order_id: o.id })),
      },
    })
    .then(must("save_route"));
  await client.rpc("send_route", { p_route_id: id }).then(must("send_route"));
  return id;
}

/** A driver on a route: their path, progress and pending GPS points. */
async function makeDriver(email, routeId, { completeFirst, speedingLeg }) {
  const { client, userId } = await signIn(email);
  await client.rpc("start_route", { p_route_id: routeId }).then(must("start_route"));
  const route = await client
    .from("routes")
    .select("id, vehicle_id, depot:depots(lon, lat), route_stops(id, sequence, status, location:locations(name, lon, lat), order:orders(reference))")
    .eq("id", routeId)
    .single()
    .then(must("route"));
  const stops = [...route.route_stops].sort((a, b) => a.sequence - b.sequence);
  const depot = [route.depot.lon, route.depot.lat];
  const channel = client.channel(`tenant:${TENANT}`);
  channel.subscribe();
  return { email, client, userId, routeId, vehicleId: route.vehicle_id, stops, depot, position: depot, legIndex: stops.findIndex((s) => ["scheduled", "arrived"].includes(s.status)), completeFirst, speedingLeg, buffer: [], channel, photo: 0 };
}

async function uploadBatch(d) {
  if (!d.buffer.length) return;
  const points = d.buffer.splice(0, d.buffer.length);
  await d.client
    .from("gps_batches")
    .insert({
      id: randomUUID(),
      tenant_id: TENANT,
      driver_id: d.userId,
      vehicle_id: d.vehicleId,
      recorded_from: new Date(points[0][0]).toISOString(),
      recorded_to: new Date(points.at(-1)[0]).toISOString(),
      point_count: points.length,
      points,
    })
    .then(must("gps upload"));
}

async function complete(d, stop, at, outcome = "delivered") {
  const photoPath = `${TENANT}/${stop.id}/photo.png`;
  const signaturePath = `${TENANT}/${stop.id}/signature.png`;
  d.photo++;
  await d.client.storage.from("delivery-proofs").upload(photoPath, demoPhoto(d.photo + stop.sequence), { contentType: "image/png", upsert: true });
  await d.client.storage.from("delivery-proofs").upload(signaturePath, demoSignature(stop.sequence), { contentType: "image/png", upsert: true });
  await d.client
    .rpc("complete_stop", {
      p_stop_id: stop.id,
      p_proof: {
        id: randomUUID(),
        outcome,
        received_by: ["Ana Tora", "Ravi Chand", "Mere Vula", "Joseph Lal"][stop.sequence % 4],
        partial_notes: outcome === "partially_delivered" ? "Two cartons of rice short. Shop will take them on the next run." : null,
        photo_path: photoPath,
        signature_path: signaturePath,
        lon: stop.location.lon,
        lat: stop.location.lat,
        accuracy_m: 6,
        captured_at: new Date(at).toISOString(),
      },
    })
    .then(must("complete_stop"));
  stop.status = outcome;
  console.log(`${d.email}: ${outcome} at ${stop.location.name}`);
}

/** Drive one leg from the current position to `to`, recording points from time t. */
/** Drive along a road path from time t, recording a point every few seconds; stop at `fraction` of it. */
function driveLeg(d, path, t, speeding, fraction = 1) {
  const metres = pathLength(path) * fraction;
  let travelled = 0;
  let i = 0;
  while (travelled < metres) {
    // Pull away slowly, cruise, slow down at the end; one stretch over the limit if asked.
    const progress = travelled / metres;
    let kmh = KMH + 6 * Math.sin(i / 3);
    if (progress < 0.08 || progress > 0.92) kmh = 18;
    if (speeding && progress > 0.2 && progress < 0.7) kmh = 66 + (i % 3);
    const mps = kmh / 3.6;
    travelled = Math.min(metres, travelled + mps * STEP_S);
    t += STEP_S * 1000;
    const { pos, heading } = along(path, travelled);
    d.buffer.push([Math.round(t), +pos[0].toFixed(6), +pos[1].toFixed(6), 5 + (i % 4), +mps.toFixed(2), heading]);
    i++;
  }
  d.position = along(path, metres).pos;
  return t;
}

async function backfill(d, endAt) {
  // Road paths for the legs already driven this morning, then work out how
  // long they took so the morning ends now.
  const legs = [];
  let from = d.depot;
  for (let k = 0; k <= d.completeFirst; k++) {
    const to = [d.stops[k].location.lon, d.stops[k].location.lat];
    legs.push(await roadPath(from, to));
    from = to;
  }
  let t = 0;
  const probe = { buffer: [], position: d.depot };
  for (let k = 0; k < d.completeFirst; k++) t = driveLeg(probe, legs[k], t, false) + 6 * 60_000;
  t = driveLeg(probe, legs[d.completeFirst], t, false, 0.4);
  let clock = endAt - t;

  d.position = d.depot;
  for (let k = 0; k < d.completeFirst; k++) {
    const stop = d.stops[k];
    clock = driveLeg(d, legs[k], clock, d.speedingLeg === k);
    // Park for the delivery: a few stationary points.
    for (let s = 0; s < 6; s++) d.buffer.push([(clock += 60_000), d.position[0], d.position[1], 4, 0, 0]);
    await uploadInChunks(d);
    await complete(d, stop, clock, k === 1 ? "partially_delivered" : "delivered");
  }
  d.legIndex = d.completeFirst;
  // Part of the way to the next stop, then carry on live from there.
  driveLeg(d, legs[d.completeFirst], clock, false, 0.4);
  d.path = legs[d.completeFirst];
  d.along = pathLength(d.path) * 0.4;
  await uploadInChunks(d);
}

async function uploadInChunks(d) {
  const all = d.buffer.splice(0, d.buffer.length);
  for (let i = 0; i < all.length; i += 15) {
    d.buffer = all.slice(i, i + 15);
    await uploadBatch(d);
  }
  d.buffer = [];
}

async function tick(d) {
  const next = d.stops[d.legIndex];
  if (!next) return;
  const to = [next.location.lon, next.location.lat];
  if (!d.path) {
    d.path = await roadPath(d.position, to);
    d.along = 0;
  }
  const mps = (KMH + 5 * Math.sin(Date.now() / 20000)) / 3.6;
  d.along += mps * 3; // three seconds of driving
  const now = Date.now();
  if (d.along >= pathLength(d.path)) {
    d.position = to;
    d.path = null;
    d.buffer.push([now, to[0], to[1], 5, 0, 0]);
    await uploadBatch(d);
    await complete(d, next, now);
    d.legIndex++;
    return;
  }
  const { pos, heading } = along(d.path, d.along);
  d.position = pos;
  d.buffer.push([now, +pos[0].toFixed(6), +pos[1].toFixed(6), 5, +mps.toFixed(2), heading]);
  await d.channel.send({
    type: "broadcast",
    event: "position",
    payload: { driver_id: d.userId, lon: pos[0], lat: pos[1], speed_kmh: Math.round(mps * 3.6), heading, at: new Date(now).toISOString() },
  });
}

/** As the dispatcher: give a route its road line (the planned geometry). */
async function setRoadGeometry(routeId) {
  const { client } = await signIn("dispatch@nadera.test");
  const route = await client.from("routes").select("depot:depots(lon, lat), route_stops(sequence, location:locations(lon, lat))").eq("id", routeId).single().then(must("route"));
  const points = [[route.depot.lon, route.depot.lat], ...route.route_stops.sort((a, b) => a.sequence - b.sequence).map((s) => [s.location.lon, s.location.lat]), [route.depot.lon, route.depot.lat]];
  const line = [];
  for (let i = 1; i < points.length; i++) line.push(...(await roadPath(points[i - 1], points[i])).slice(i === 1 ? 0 : 1));
  const wkt = `SRID=4326;LINESTRING(${line.map((p) => `${p[0]} ${p[1]}`).join(",")})`;
  await client.from("routes").update({ geometry: wkt, planned_distance_m: Math.round(pathLength(line)) }).eq("id", routeId).then(must("route geometry"));
}

const vikashRoute = await ensureVikashRoute();
await setRoadGeometry("60000000-0000-4000-8000-000000000001");
await setRoadGeometry(vikashRoute);
const drivers = [
  await makeDriver("driver1@nadera.test", "60000000-0000-4000-8000-000000000001", { completeFirst: 2, speedingLeg: 1 }),
  await makeDriver("driver3@nadera.test", vikashRoute, { completeFirst: 1, speedingLeg: -1 }),
];
const now = Date.now();
for (const d of drivers) {
  if (d.legIndex === 0) await backfill(d, now - 30_000);
}
console.log("Back-fill done.");

if (ONCE) process.exit(0);
let n = 0;
setInterval(async () => {
  n++;
  for (const d of drivers) {
    try {
      await tick(d);
      if (n % 5 === 0) await uploadBatch(d);
    } catch (e) {
      console.error(d.email, e.message);
    }
  }
}, 3000);
console.log("Driving. Stop with Ctrl+C.");
