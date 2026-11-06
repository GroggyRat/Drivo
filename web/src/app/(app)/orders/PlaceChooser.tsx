"use client";

import { Field } from "@/components/ui";
import { LocationPicker } from "../locations/LocationPicker";

export type Place = { id: string; name: string; lon: number; lat: number };

/** "Where to deliver": a shop Drivo knows, or a new pin on the map. */
export function PlaceChooser({ places, place, setPlace, placeName, setPlaceName, initialPin }: {
  places: Place[];
  place: string;
  setPlace: (id: string) => void;
  placeName: string;
  setPlaceName: (name: string) => void;
  initialPin?: [number, number] | null;
}) {
  return (
    <>
      <Field label="Where to deliver" htmlFor="locationId" hint="Choose a shop Drivo knows, or drop a pin for a new one.">
        <select
          id="locationId" name="locationId" className="input" value={place}
          onChange={(e) => { setPlace(e.target.value); setPlaceName(places.find((p) => p.id === e.target.value)?.name ?? ""); }}
        >
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value="new">A new place: drop a pin</option>
        </select>
      </Field>
      {place === "new" && (
        <div className="space-y-3 rounded-[var(--radius-card)] border border-line p-3">
          <Field label="Shop name" htmlFor="placeName">
            <input id="placeName" name="placeName" className="input" required value={placeName} onChange={(e) => setPlaceName(e.target.value)} />
          </Field>
          <LocationPicker height={260} initial={initialPin} others={places.map((p) => ({ id: p.id, position: [p.lon, p.lat] as [number, number], kind: "shop" as const, label: p.name }))} />
          <Field label="Directions for the driver" htmlFor="directions">
            <input id="directions" name="directions" className="input" placeholder="For example: blue shop opposite the school" />
          </Field>
        </div>
      )}
    </>
  );
}
