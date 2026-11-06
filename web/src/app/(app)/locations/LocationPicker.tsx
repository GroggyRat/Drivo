"use client";

import { useState } from "react";
import MapView, { type MapMarker } from "@/components/MapView";
import { Field } from "@/components/ui";
import type { LngLat } from "@/lib/geo";

/** Latitude and longitude fields with a map: click the map to place the pin. */
export function LocationPicker({ initial, others = [], height = 300 }: { initial?: LngLat | null; others?: MapMarker[]; height?: number }) {
  const [pos, setPos] = useState<LngLat | null>(initial ?? null);
  return (
    <div className="space-y-3">
      <MapView
        height={height}
        fitKey={initial ? "initial" : "none"}
        markers={[...others, ...(pos ? [{ id: "picked", position: pos, kind: "selected" as const, label: "New position" }] : [])]}
        onMapClick={(p) => setPos([Number(p[0].toFixed(6)), Number(p[1].toFixed(6))])}
        ariaLabel="Click the map to place the pin"
      />
      <p className="text-xs text-muted">Click the map to place the pin, or type the coordinates.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Latitude" htmlFor="lat">
          <input id="lat" name="lat" className="input" inputMode="decimal" required value={pos?.[1] ?? ""} onChange={(e) => setPos([pos?.[0] ?? 178.44, Number(e.target.value)])} />
        </Field>
        <Field label="Longitude" htmlFor="lon">
          <input id="lon" name="lon" className="input" inputMode="decimal" required value={pos?.[0] ?? ""} onChange={(e) => setPos([Number(e.target.value), pos?.[1] ?? -18.14])} />
        </Field>
      </div>
    </div>
  );
}
