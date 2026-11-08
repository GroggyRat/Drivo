"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import MapView, { type MapLine, type MapMarker } from "@/components/MapView";
import { LogoMark } from "@/components/Logo";
import { formatDistance, formatTime } from "@/lib/format";
import { haversine, type LngLat } from "@/lib/geo";
import { getBrowserClient } from "@/lib/supabase/client";
import { decodePolyline6, estimateKmh, nextManeuver, type NavStep, type SpeedSample } from "./navigation";
import { ProofForm } from "./ProofForm";

type Stop = {
  id: string;
  sequence: number;
  status: string;
  planned_eta: string | null;
  location: { id: string; name: string; lon: number; lat: number; landmark_directions: string | null };
  order: { id: string; reference: string; customer_name: string; cartons: number; invoice_pdf_path: string | null; customer: { phone: string | null } | null } | null;
};
type Route = {
  id: string;
  name: string | null;
  status: string;
  vehicle_id: string | null;
  planned_distance_m: number | null;
  geometry_geojson: { type: "LineString"; coordinates: LngLat[] } | null;
  depot: { name: string; lon: number; lat: number };
  route_stops: Stop[];
};
type Shift = { clock_in_here: boolean; tracking: boolean; shift: { id: string; source: string; started_at: string } | null };
type Fix = { position: LngLat; accuracy: number; speedMps: number | null; heading: number | null; at: number; kmh: number };
type Nav = { stopId: string; line: LngLat[]; steps: NavStep[]; fetchedAt: number };

const ROUTE_COLUMNS =
  "id, name, status, vehicle_id, planned_distance_m, geometry_geojson, depot:depots(name, lon, lat), " +
  "route_stops(id, sequence, status, planned_eta, location:locations(id, name, lon, lat, landmark_directions), " +
  "order:orders(id, reference, customer_name, cartons, invoice_pdf_path, customer:customers(phone)))";

const OPEN = ["scheduled", "arrived"];
const today = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

export function DriverApp({ userId, tenantId, tenantName, driverName, timeZone }: { userId: string; tenantId: string; tenantName: string; driverName: string; timeZone: string }) {
  const supabase = getBrowserClient();
  const [shift, setShift] = useState<Shift | null>(null);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [nav, setNav] = useState<Nav | null>(null);
  const [follow, setFollow] = useState(true);
  const [voice, setVoice] = useState(true);
  const [lastUpload, setLastUpload] = useState<number | null>(null);
  const [online, setOnline] = useState(true);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      supabase.rpc("my_shift", { p_tenant_id: tenantId }),
      supabase.from("routes").select(ROUTE_COLUMNS).eq("tenant_id", tenantId).eq("driver_id", userId).eq("route_date", today(timeZone)).in("status", ["sent", "in_progress", "completed"]),
    ]);
    if (s.error || r.error) {
      setError("Could not load today's run. Check your signal and try again.");
      return;
    }
    setError(null);
    setShift(s.data as Shift);
    setRoutes((r.data ?? []) as unknown as Route[]);
  }, [supabase, tenantId, userId, timeZone]);

  useEffect(() => {
    // Loading data from Supabase on mount; the state updates happen after the awaits.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    on();
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);

  const route = useMemo(() => routes?.find((r) => r.status === "in_progress") ?? routes?.find((r) => r.status === "sent") ?? routes?.[0] ?? null, [routes]);
  const stops = useMemo(() => [...(route?.route_stops ?? [])].sort((a, b) => a.sequence - b.sequence), [route]);
  const next = stops.find((s) => OPEN.includes(s.status)) ?? null;
  const after = next ? stops.find((s) => s.sequence > next.sequence && OPEN.includes(s.status)) : null;
  const tracking = Boolean(shift?.tracking);

  // ---- Location: watch while the page is open; share while on shift. ----
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      // Reporting a browser limitation once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGeoError("This browser cannot share location.");
      return;
    }
    const recent: SpeedSample[] = [];
    let smoothed = 0;
    let lastAt = 0;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGeoError(null);
        if (p.timestamp <= lastAt) return; // a repeated, cached fix
        lastAt = p.timestamp;
        const position: LngLat = [p.coords.longitude, p.coords.latitude];
        const kmh = estimateKmh(recent, { position, at: p.timestamp, accuracy: p.coords.accuracy }, p.coords.speed);
        if (kmh != null) smoothed = kmh < 3 ? 0 : smoothed === 0 ? kmh : smoothed * 0.5 + kmh * 0.5;
        setFix({ position, accuracy: p.coords.accuracy, speedMps: p.coords.speed, heading: p.coords.heading, at: p.timestamp, kmh: smoothed });
      },
      (e) => setGeoError(e.code === e.PERMISSION_DENIED ? "Location is turned off for this website. In Settings, Privacy and Security, Location Services, Safari Websites, choose While Using the App." : "Waiting for a GPS signal."),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Keep the screen on while sharing, so the phone does not stop the page.
  useEffect(() => {
    if (!tracking || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const take = async () => {
      try {
        if (document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen");
      } catch {
        // Not allowed (for example in Low Power Mode); the page still works.
      }
    };
    void take();
    document.addEventListener("visibilitychange", take);
    return () => {
      document.removeEventListener("visibilitychange", take);
      void lock?.release();
    };
  }, [tracking]);

  // Live position for the dispatcher's map (Realtime Broadcast) and GPS batches for the day's record.
  const channel = useRef<RealtimeChannel | null>(null);
  const buffer = useRef<(number | null)[][]>([]);
  const lastBroadcast = useRef(0);
  useEffect(() => {
    if (!tracking) return;
    const ch = supabase.channel(`tenant:${tenantId}`);
    ch.subscribe();
    channel.current = ch;
    return () => {
      void supabase.removeChannel(ch);
      channel.current = null;
    };
  }, [tracking, supabase, tenantId]);

  useEffect(() => {
    if (!fix || !tracking) return;
    if (fix.accuracy > 100) return;
    const kmh = fix.kmh;
    buffer.current.push([fix.at, +fix.position[0].toFixed(6), +fix.position[1].toFixed(6), Math.round(fix.accuracy), +(kmh / 3.6).toFixed(2), fix.heading != null ? Math.round(fix.heading) : null]);
    if (fix.at - lastBroadcast.current >= 3000 && channel.current) {
      lastBroadcast.current = fix.at;
      void channel.current.send({
        type: "broadcast",
        event: "position",
        payload: { driver_id: userId, lon: fix.position[0], lat: fix.position[1], speed_kmh: Math.round(kmh), heading: fix.heading, at: new Date(fix.at).toISOString() },
      });
    }
  }, [fix, tracking, userId]);

  const upload = useCallback(async () => {
    const points = buffer.current;
    if (!points.length) return;
    buffer.current = [];
    const { error: e } = await supabase.from("gps_batches").insert({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      driver_id: userId,
      vehicle_id: route?.vehicle_id ?? null,
      recorded_from: new Date(points[0][0]!).toISOString(),
      recorded_to: new Date(points[points.length - 1][0]!).toISOString(),
      point_count: points.length,
      points,
    });
    if (e) buffer.current = [...points, ...buffer.current].slice(-1500);
    else setLastUpload(Date.now());
  }, [supabase, tenantId, userId, route?.vehicle_id]);

  useEffect(() => {
    if (!tracking) return;
    const t = setInterval(upload, 30_000);
    const flush = () => document.visibilityState === "hidden" && void upload();
    document.addEventListener("visibilitychange", flush);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", flush);
      void upload();
    };
  }, [tracking, upload]);

  // ---- Directions to the next stop from Drivo's road router. ----
  const navStopId = route?.status === "in_progress" && next ? next.id : null;
  const fixRef = useRef<Fix | null>(null);
  const navInFlight = useRef(false);
  useEffect(() => {
    fixRef.current = fix;
  }, [fix]);
  const nextLon = next?.location.lon, nextLat = next?.location.lat;
  const fetchNav = useCallback(async () => {
    const fix = fixRef.current;
    if (!navStopId || nextLon == null || nextLat == null || !fix || navInFlight.current) return;
    navInFlight.current = true;
    try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const res = await fetch("/api/navigation/route", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ locations: [{ lat: fix.position[1], lon: fix.position[0] }, { lat: nextLat, lon: nextLon }] }),
    }).catch(() => null);
    if (!res?.ok) return;
    const body = await res.json();
    const r = body.routes?.[0];
    if (!r) return;
    const steps: NavStep[] = r.legs[0].steps.map((s: { maneuver: { location: LngLat; instruction: string; type: string; modifier?: string }; distance: number; name: string }) => ({
      location: s.maneuver.location, instruction: s.maneuver.instruction, type: s.maneuver.type, modifier: s.maneuver.modifier ?? null, distance: s.distance,
    }));
    setNav({ stopId: navStopId, line: decodePolyline6(r.geometry), steps, fetchedAt: Date.now() });
    } finally {
      navInFlight.current = false;
    }
  }, [navStopId, nextLon, nextLat, supabase]);

  const offRoute = useMemo(() => {
    if (!nav || !fix) return false;
    let best = Infinity;
    for (let i = 0; i < nav.line.length; i += 2) best = Math.min(best, haversine(nav.line[i], fix.position));
    return best > 80;
  }, [nav, fix]);
  const haveFix = Boolean(fix);
  useEffect(() => {
    if (!navStopId || !haveFix) return;
    if (!nav || nav.stopId !== navStopId || (offRoute && Date.now() - nav.fetchedAt > 20_000)) void fetchNav();
  }, [navStopId, haveFix, nav, offRoute, fetchNav]);

  const step = nav && fix && nav.stopId === navStopId ? nextManeuver(nav.steps, fix.position) : null;

  // Spoken directions (Safari speaks after the first tap on the page).
  const spoken = useRef(new Set<string>());
  useEffect(() => {
    if (!voice || !step || !("speechSynthesis" in window)) return;
    const say = (key: string, text: string) => {
      if (spoken.current.has(key)) return;
      spoken.current.add(key);
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-GB";
      window.speechSynthesis.speak(u);
    };
    const k = `${nav?.fetchedAt}-${step.index}`;
    const text = step.instruction.charAt(0).toLowerCase() + step.instruction.slice(1);
    if (step.distanceM > 250 && step.distanceM < 350) say(`${k}-300`, `In 300 metres, ${text}.`);
    if (step.distanceM <= 70) say(`${k}-now`, `${step.instruction}.`);
  }, [step, voice, nav?.fetchedAt]);

  // ---- Actions ----
  const act = async (label: string, fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(label);
    setError(null);
    try {
      const { error: e } = await fn();
      if (e) setError(e.message);
      await load();
    } finally {
      setBusy(null);
    }
  };
  const unlockSpeech = () => {
    if (voice && "speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  };

  const openInvoice = async (path: string) => {
    // Open the tab during the tap so Safari allows it, then point it at the signed link.
    const tab = window.open("", "_blank");
    const { data, error: e } = await supabase.storage.from("invoices").createSignedUrl(path, 300);
    if (e || !data) {
      tab?.close();
      setError("Could not open the invoice. Check your signal.");
      return;
    }
    if (tab) tab.location.href = data.signedUrl;
    else window.location.href = data.signedUrl;
  };

  // ---- Map ----
  const markers: MapMarker[] = useMemo(() => {
    const list: MapMarker[] = stops.map((s) => ({
      id: s.id, position: [s.location.lon, s.location.lat], text: String(s.sequence), label: s.location.name,
      kind: OPEN.includes(s.status) ? (s.id === next?.id ? "selected" : "stop") : "done",
    }));
    if (route) list.push({ id: "depot", position: [route.depot.lon, route.depot.lat], text: "D", kind: "depot", label: route.depot.name });
    if (fix) list.push({ id: "me", position: fix.position, kind: "vehicle", heading: fix.heading, label: "You" });
    return list;
  }, [stops, route, fix, next?.id]);
  const lines: MapLine[] = useMemo(() => {
    if (nav && nav.stopId === navStopId) return [{ id: "nav", coordinates: nav.line, width: 6 }];
    if (route?.geometry_geojson) return [{ id: "route", coordinates: route.geometry_geojson.coordinates, opacity: 0.5 }];
    return [];
  }, [nav, navStopId, route]);

  const done = stops.filter((s) => !OPEN.includes(s.status)).length;
  const toNext = next && fix ? haversine(fix.position, [next.location.lon, next.location.lat]) : null;

  return (
    <div className="min-h-screen bg-page pb-10" onClick={unlockSpeech}>
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-navy px-4 py-3 text-white">
        <div className="flex min-w-0 items-center gap-2">
          <LogoMark size={28} />
          <div className="min-w-0">
            <div className="truncate font-semibold">{tenantName}</div>
            <div className="truncate text-xs text-white/75">{driverName}</div>
          </div>
        </div>
        <form action="/auth/sign-out" method="post">
          <button type="submit" className="rounded-lg border border-white/40 px-3 py-2 text-sm">Sign out</button>
        </form>
      </header>

      <main className="mx-auto max-w-xl space-y-3 px-3 pt-3">
        {!online && <p className="rounded-lg bg-[#FEF0C7] px-3 py-2 text-sm text-[#93370D]">No signal. Your points are kept on this page and sent when the signal returns. Keep this page open.</p>}
        {error && <p role="alert" className="rounded-lg bg-[#FEE4E2] px-3 py-2 text-sm text-[#B42318]">{error}</p>}

        {/* Shift */}
        <section className="card p-3">
          {shift?.shift ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">On shift since {formatTime(shift.shift.started_at, timeZone)}</div>
                <div className="text-sm text-muted">
                  {geoError ?? (fix ? `Sharing your location. ${lastUpload ? `Last sent ${formatTime(new Date(lastUpload), timeZone)}.` : ""}` : "Finding your location.")}
                </div>
              </div>
              {shift.clock_in_here && shift.shift.source === "drivo" && (
                <button className="btn-secondary shrink-0" disabled={!!busy} onClick={() => act("out", async () => { await upload(); return supabase.rpc("clock_out", { p_tenant_id: tenantId }); })}>
                  {busy === "out" ? "Clocking out" : "Clock out"}
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">Not on shift</div>
                <div className="text-sm text-muted">{shift?.clock_in_here ? "Clock in to start sharing your location." : "Your shift starts with KaiWorkforce or when you start your route."}</div>
              </div>
              {shift?.clock_in_here && (
                <button className="btn-primary shrink-0" disabled={!!busy} onClick={() => act("in", () => supabase.rpc("clock_in", { p_tenant_id: tenantId }))}>
                  {busy === "in" ? "Clocking in" : "Clock in"}
                </button>
              )}
            </div>
          )}
          {tracking && <p className="mt-2 text-xs text-muted">Keep this page open with the screen on. Your location stops sharing if you close Safari or lock the phone.</p>}
        </section>

        {/* Directions */}
        {step && route?.status === "in_progress" && (
          <section className="flex items-center gap-3 rounded-[var(--radius-card)] bg-navy p-3 text-white" aria-live="polite">
            <TurnIcon type={step.type} modifier={step.modifier} />
            <div className="min-w-0 flex-1">
              <div className="text-2xl font-semibold">{formatDistance(Math.round(step.distanceM / 10) * 10)}</div>
              <div className="text-sm text-white/85">{step.instruction}</div>
            </div>
            <button className="rounded-lg border border-white/40 px-3 py-2 text-sm" onClick={(e) => { e.stopPropagation(); setVoice((v) => !v); window.speechSynthesis?.cancel(); }}>
              {voice ? "Mute" : "Unmute"}
            </button>
          </section>
        )}

        {/* Map */}
        {route && (
          <section className="relative">
            <MapView markers={markers} lines={lines} height="42vh" fitKey={route.id} follow={follow ? fix?.position ?? null : null} ariaLabel="Map of today's run" />
            {fix && (
              <div className="absolute bottom-3 left-3 flex gap-2">
                <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium shadow-sm" onClick={() => setFollow((f) => !f)}>{follow ? "Show whole run" : "Follow me"}</button>
                <span className="rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium tabular-nums shadow-sm">{now - fix.at > 15000 ? "No GPS" : `${Math.round(fix.kmh)} km/h`}</span>
              </div>
            )}
          </section>
        )}

        {/* Today's run */}
        {routes === null ? (
          <section className="card p-4 text-muted">Loading today&apos;s run.</section>
        ) : !route ? (
          <section className="card p-4">
            <h1 className="font-semibold">No route for today</h1>
            <p className="mt-1 text-sm text-muted">When your dispatcher sends you a route, it appears here.</p>
            <button className="btn-secondary mt-3" onClick={() => void load()}>Refresh today&apos;s run</button>
          </section>
        ) : (
          <>
            <section className="card p-3">
              <div className="flex items-baseline justify-between gap-2">
                <h1 className="font-semibold">{route.name ?? "Today's run"}</h1>
                <span className="text-sm text-muted">{done} of {stops.length} stops done</span>
              </div>
              {route.status === "sent" && (
                <button className="btn-primary mt-3 w-full" disabled={!!busy} onClick={() => act("start", () => supabase.rpc("start_route", { p_route_id: route.id }))}>
                  {busy === "start" ? "Starting" : "Start route"}
                </button>
              )}
              {route.status === "completed" && <p className="mt-2 text-sm text-muted">Route finished. Head back to {route.depot.name}.</p>}
            </section>

            {next && route.status === "in_progress" && (
              next.status === "arrived" ? (
                <ProofForm
                  key={next.id}
                  stop={next}
                  tenantId={tenantId}
                  fix={fix}
                  onOpenInvoice={openInvoice}
                  onDone={async () => { await load(); }}
                />
              ) : (
                <section className="card p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">Next stop</div>
                  <div className="mt-1 text-lg font-semibold">{next.sequence}. {next.location.name}</div>
                  {next.order && <div className="text-sm text-muted">{next.order.reference}, {next.order.customer_name}, {next.order.cartons} cartons</div>}
                  <div className="text-sm text-muted">
                    {next.planned_eta ? `Planned ${formatTime(next.planned_eta, timeZone)}` : ""}
                    {toNext != null ? `${next.planned_eta ? ". " : ""}${formatDistance(toNext)} away in a straight line` : ""}
                  </div>
                  {next.location.landmark_directions && <p className="mt-2 rounded-lg bg-page p-2 text-sm">{next.location.landmark_directions}</p>}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button className="btn-primary" disabled={!!busy} onClick={() => act("arrive", () => supabase.rpc("arrive_stop", { p_stop_id: next.id, p_lon: fix?.position[0] ?? null, p_lat: fix?.position[1] ?? null }))}>
                      {busy === "arrive" ? "Saving" : "Arrived"}
                    </button>
                    {next.order?.invoice_pdf_path ? (
                      <button className="btn-secondary" onClick={() => void openInvoice(next.order!.invoice_pdf_path!)}>Open invoice</button>
                    ) : next.order?.customer?.phone ? (
                      <a className="btn-secondary" href={`tel:${next.order.customer.phone}`}>Call shop</a>
                    ) : <span />}
                  </div>
                  {after && <p className="mt-2 text-sm text-muted">Then: {after.location.name}</p>}
                </section>
              )
            )}

            <section className="card p-0">
              <h2 className="border-b border-line px-3 py-2 text-sm font-semibold">All stops</h2>
              <ol>
                {stops.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-0">
                    <div className="min-w-0">
                      <div className="truncate">{s.sequence}. {s.location.name}</div>
                      <div className="truncate text-xs text-muted">{[s.order?.reference, s.planned_eta ? `Planned ${formatTime(s.planned_eta, timeZone)}` : null].filter(Boolean).join(", ")}</div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${OPEN.includes(s.status) ? "bg-[#EEF1F5] text-[#344054]" : s.status === "failed" ? "bg-[#FEE4E2] text-[#B42318]" : "bg-[#DCFCE7] text-[#166534]"}`}>{label(s.status)}</span>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}

        <p className="px-1 text-xs text-muted">
          This is the Drivo driver page for phones without the app. The Drivo app keeps sharing your location with the screen off and works without signal.
        </p>
      </main>
    </div>
  );
}

function label(status: string) {
  return ({ scheduled: "To do", arrived: "Arrived", delivered: "Delivered", partially_delivered: "Part delivered", failed: "Not delivered", skipped: "Skipped" } as Record<string, string>)[status] ?? status;
}

function TurnIcon({ type, modifier }: { type: string; modifier: string | null }) {
  const rotate = type === "arrive" ? 0 : modifier?.includes("left") ? (modifier.includes("slight") ? -40 : modifier.includes("sharp") ? -130 : -90) : modifier?.includes("right") ? (modifier.includes("slight") ? 40 : modifier.includes("sharp") ? 130 : 90) : modifier === "uturn" ? 180 : 0;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true" className="shrink-0">
      {type === "arrive" ? (
        <path d="M22 6c-6 0-11 5-11 11 0 9 11 21 11 21s11-12 11-21c0-6-5-11-11-11zm0 15a4 4 0 1 1 0-8 4 4 0 0 1 0 8z" fill="#fff" />
      ) : (
        <g transform={`rotate(${rotate} 22 22)`}>
          <path d="M22 38V10" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
          <path d="M12 18l10-10 10 10" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  );
}
