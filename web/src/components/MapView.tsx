"use client";

import { useEffect, useRef } from "react";
import maplibregl, { type Map as MlMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { boundsOf, fijiLng, FIJI_CENTRE, type LngLat } from "@/lib/geo";

// MapProvider: the style comes from NEXT_PUBLIC_MAP_STYLE_URL (the Fiji
// Protomaps extract on Cloudflare R2 in production, OpenFreeMap in
// development). Without it, a built-in outline map of Fiji's coastline is
// used, which has no roads.

export type MapMarker = {
  id: string;
  position: LngLat;
  label?: string;
  /** Text inside the marker, for example a stop number. */
  text?: string;
  kind?: "stop" | "depot" | "vehicle" | "pending" | "hazard" | "fuel" | "shop" | "selected" | "done";
  heading?: number | null;
  faded?: boolean;
  onClick?: () => void;
};

export type MapLine = { id: string; coordinates: LngLat[]; color?: string; width?: number; dashed?: boolean; opacity?: number };

const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    land: { type: "geojson", data: "/basemap/fiji-land.geojson", attribution: "Coastline: Natural Earth" },
  },
  layers: [
    { id: "water", type: "background", paint: { "background-color": "#dbe7f3" } },
    { id: "land", type: "fill", source: "land", paint: { "fill-color": "#f7f8fa" } },
    { id: "coast", type: "line", source: "land", paint: { "line-color": "#b8c4d4", "line-width": 1 } },
  ],
};

const MARKER_STYLE: Record<NonNullable<MapMarker["kind"]>, string> = {
  stop: "background:#2563eb;color:#fff;border:2px solid #fff",
  done: "background:#166534;color:#fff;border:2px solid #fff",
  depot: "background:#0b1f44;color:#fff;border:2px solid #fff;border-radius:6px",
  vehicle: "background:#2563eb;color:#fff;border:3px solid #fff;box-shadow:0 0 0 2px #2563eb",
  pending: "background:#fef0c7;color:#93370d;border:2px solid #93370d",
  hazard: "background:#b42318;color:#fff;border:2px solid #fff",
  fuel: "background:#344054;color:#fff;border:2px solid #fff",
  shop: "background:#fff;color:#0b1f44;border:2px solid #0b1f44",
  selected: "background:#0b0b0c;color:#fff;border:3px solid #fff;box-shadow:0 0 0 2px #0b0b0c",
};

// Town names for the built-in outline map, which has no labels of its own.
const TOWNS: { name: string; position: LngLat }[] = [
  { name: "Suva", position: [178.4419, -18.1416] },
  { name: "Nasinu", position: [178.4800, -18.0700] },
  { name: "Nausori", position: [178.5450, -18.0310] },
  { name: "Lami", position: [178.4130, -18.1180] },
  { name: "Navua", position: [178.1700, -18.2250] },
  { name: "Nadi", position: [177.4167, -17.8000] },
  { name: "Lautoka", position: [177.4503, -17.6088] },
  { name: "Labasa", position: [179.3940, -16.4330] },
  { name: "Savusavu", position: [179.3360, -16.7770] },
  { name: "Levuka", position: [178.8330, -17.6830] },
  { name: "Taveuni", position: [-179.9700, -16.8500] },
  { name: "Lakeba", position: [-178.8000, -18.2000] },
];

function townLabel(name: string) {
  const el = document.createElement("span");
  el.textContent = name;
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "font:500 11px 'IBM Plex Sans',sans-serif;color:#5d6b82;letter-spacing:0.02em;pointer-events:none;text-shadow:0 0 3px #f7f8fa,0 0 3px #f7f8fa";
  return el;
}

function markerElement(m: MapMarker) {
  const el = document.createElement("button");
  el.type = "button";
  el.setAttribute("aria-label", m.label ?? m.text ?? "Map marker");
  if (m.label) el.title = m.label;
  const size = m.kind === "vehicle" ? 22 : m.text ? 26 : 16;
  el.style.cssText = `${MARKER_STYLE[m.kind ?? "stop"]};width:${size}px;height:${size}px;border-radius:${m.kind === "depot" ? "6px" : "999px"};display:flex;align-items:center;justify-content:center;font:600 12px 'IBM Plex Sans',sans-serif;cursor:${m.onClick ? "pointer" : "default"};opacity:${m.faded ? 0.45 : 1};padding:0`;
  if (m.text) el.textContent = m.text;
  if (m.kind === "vehicle" && m.heading != null) {
    const arrow = document.createElement("span");
    arrow.style.cssText = `position:absolute;top:-9px;left:50%;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid #2563eb;transform-origin:50% 20px;transform:translateX(-50%) rotate(${m.heading}deg)`;
    el.style.position = "relative";
    el.appendChild(arrow);
  }
  if (m.onClick) el.addEventListener("click", (e) => { e.stopPropagation(); m.onClick?.(); });
  return el;
}

export default function MapView({
  markers = [],
  lines = [],
  height = 420,
  fitKey,
  onMapClick,
  ariaLabel = "Map",
  follow,
}: {
  markers?: MapMarker[];
  lines?: MapLine[];
  height?: number | string;
  /** Change this to refit the view to the markers and lines. */
  fitKey?: string;
  onMapClick?: (position: LngLat) => void;
  ariaLabel?: string;
  /** Keep the map centred on this position (driver view), zoomed in. */
  follow?: LngLat | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markerRefs = useRef<maplibregl.Marker[]>([]);
  const loaded = useRef(false);
  const clickRef = useRef(onMapClick);
  const latest = useRef({ markers, lines });
  const followRef = useRef(follow);
  useEffect(() => {
    clickRef.current = onMapClick;
    latest.current = { markers, lines };
    followRef.current = follow;
  });

  useEffect(() => {
    if (!container.current) return;
    const style = process.env.NEXT_PUBLIC_MAP_STYLE_URL || FALLBACK_STYLE;
    const m = new maplibregl.Map({
      container: container.current,
      style,
      center: FIJI_CENTRE,
      zoom: 10,
      attributionControl: { compact: true, customAttribution: "© OpenStreetMap contributors" },
      renderWorldCopies: true,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    if (style === FALLBACK_STYLE) {
      TOWNS.forEach((t) => new maplibregl.Marker({ element: townLabel(t.name) }).setLngLat([fijiLng(t.position[0]), t.position[1]]).addTo(m));
    }
    m.on("click", (e) => clickRef.current?.([((e.lngLat.lng + 540) % 360) - 180, e.lngLat.lat]));
    m.on("load", () => {
      loaded.current = true;
      draw(m, latest.current.lines);
      if (followRef.current) m.jumpTo({ center: [fijiLng(followRef.current[0]), followRef.current[1]], zoom: 16 });
      else fit(m, latest.current.markers, latest.current.lines);
    });
    map.current = m;
    // Keep the canvas the size of its container as the layout settles.
    const observer = new ResizeObserver(() => m.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
      loaded.current = false;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    markerRefs.current.forEach((mk) => mk.remove());
    markerRefs.current = markers.map((mk) =>
      new maplibregl.Marker({ element: markerElement(mk) }).setLngLat([fijiLng(mk.position[0]), mk.position[1]]).addTo(m),
    );
  }, [markers]);

  useEffect(() => {
    const m = map.current;
    if (m && loaded.current) draw(m, lines);
  }, [lines]);

  useEffect(() => {
    const m = map.current;
    if (m && loaded.current) fit(m, latest.current.markers, latest.current.lines);
  }, [fitKey]);

  const followKey = follow ? `${follow[0].toFixed(5)},${follow[1].toFixed(5)}` : "";
  useEffect(() => {
    const m = map.current;
    if (!m || !loaded.current || !followRef.current) return;
    const [lon, lat] = followRef.current;
    m.easeTo({ center: [fijiLng(lon), lat], zoom: Math.max(m.getZoom(), 15), duration: 800 });
  }, [followKey]);

  return <div ref={container} role="region" aria-label={ariaLabel} style={{ height }} className="w-full overflow-hidden rounded-[var(--radius-card)] border border-line" />;
}

function draw(m: MlMap, lines: MapLine[]) {
  const existing = (m.getStyle().layers ?? []).filter((l) => l.id.startsWith("drivo-line-"));
  existing.forEach((l) => m.removeLayer(l.id));
  Object.keys(m.getStyle().sources ?? {}).filter((s) => s.startsWith("drivo-line-")).forEach((s) => m.removeSource(s));
  for (const line of lines) {
    if (line.coordinates.length < 2) continue;
    const id = `drivo-line-${line.id}`;
    m.addSource(id, {
      type: "geojson",
      data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line.coordinates.map(([x, y]) => [fijiLng(x), y]) } },
    });
    m.addLayer({
      id,
      type: "line",
      source: id,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": line.color ?? "#2563eb",
        "line-width": line.width ?? 4,
        "line-opacity": line.opacity ?? 0.9,
        ...(line.dashed ? { "line-dasharray": [2, 2] } : {}),
      },
    });
  }
}

function fit(m: MlMap, markers: MapMarker[], lines: MapLine[]) {
  const points = [...markers.map((mk) => mk.position), ...lines.flatMap((l) => l.coordinates)];
  const b = boundsOf(points);
  if (!b) return;
  if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) {
    m.jumpTo({ center: b[0], zoom: 14 });
    return;
  }
  m.fitBounds(b, { padding: 48, maxZoom: 15, duration: 0 });
}
