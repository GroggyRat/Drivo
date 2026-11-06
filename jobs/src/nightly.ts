// Nightly job: for every driver-day before today (in the tenant's time
// zone) that still has GPS batches:
//   1. archive the raw points to Cloudflare R2 as gzipped NDJSON,
//   2. snap the track to roads with the routing server (when configured),
//   3. compress the day into one trips row (finish_trip), which deletes the
//      batches,
//   4. add hourly average speeds per road to segment_speeds.
// Run from cron on the routing VPS (ops/drivo-nightly.timer), after
// midnight Fiji time.
import { gzipSync } from "node:zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import { aggregateSpeeds, cleanPoints, toNdjson, type MatchedEdge, type Point } from "./speeds.js";

const env = (name: string, required = true) => {
  const v = process.env[name] ?? "";
  if (required && !v) throw new Error(`${name} is not set`);
  return v;
};

const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
});
const BUCKET = env("R2_BUCKET");
const ROUTING_URL = env("ROUTING_API_URL", false);
const ROUTING_KEY = env("ROUTING_API_KEY", false);

async function mapMatch(points: Point[]) {
  if (!ROUTING_URL || points.length < 2) return null;
  // Valhalla works best on traces of a few thousand points; match in chunks.
  const geometry: [number, number][] = [];
  const edges: (MatchedEdge & { at: number })[] = [];
  for (let i = 0; i < points.length; i += 2000) {
    const chunk = points.slice(i, i + 2001);
    const res = await fetch(`${ROUTING_URL}/v1/map-match`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ROUTING_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ points: chunk.map((p) => ({ lon: p[1], lat: p[2], time: Math.round(p[0] / 1000) })) }),
    });
    if (!res.ok) return null;
    const m = (await res.json()) as { geometry: [number, number][]; edges: MatchedEdge[] };
    geometry.push(...m.geometry);
    const at = chunk[Math.floor(chunk.length / 2)][0];
    edges.push(...m.edges.map((e) => ({ ...e, at })));
  }
  return { geometry, edges };
}

async function run() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Fiji" }).format(new Date());
  const { data: days, error } = await supabase.rpc("pending_trip_days", { p_before: today });
  if (error) throw error;
  const { data: tenants } = await supabase.from("tenants").select("id, time_zone");
  const tz = new Map((tenants ?? []).map((t) => [t.id, t.time_zone as string]));

  for (const day of (days ?? []) as { tenant_id: string; driver_id: string; trip_date: string }[]) {
    const { data: batches, error: bErr } = await supabase
      .from("gps_batches")
      .select("points")
      .eq("tenant_id", day.tenant_id)
      .eq("driver_id", day.driver_id);
    if (bErr) throw bErr;
    const points = cleanPoints((batches ?? []).flatMap((b) => b.points as Point[]));
    const key = `${day.tenant_id}/${day.driver_id}/${day.trip_date}.ndjson.gz`;
    await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: gzipSync(toNdjson(points)), ContentType: "application/x-ndjson", ContentEncoding: "gzip" }));

    const matched = await mapMatch(points);
    const { error: tErr } = await supabase.rpc("finish_trip", {
      p_tenant_id: day.tenant_id,
      p_driver_id: day.driver_id,
      p_trip_date: day.trip_date,
      p_archive_path: `r2://${BUCKET}/${key}`,
      p_matched_line: matched && matched.geometry.length > 1 ? { type: "LineString", coordinates: matched.geometry } : null,
    });
    if (tErr) throw tErr;
    if (matched) {
      const rows = aggregateSpeeds(matched.edges, tz.get(day.tenant_id) ?? "Pacific/Fiji");
      if (rows.length) await supabase.rpc("add_segment_speeds", { p_tenant_id: day.tenant_id, p_rows: rows });
    }
    console.log(`Trip ${day.trip_date} for ${day.driver_id}: ${points.length} points archived${matched ? ", road-matched" : ""}.`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
