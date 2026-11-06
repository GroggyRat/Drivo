"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { PlaceChooser, type Place } from "../../PlaceChooser";

function Submit() {
  const { pending } = useFormStatus();
  return <button type="submit" className="btn-primary" disabled={pending}>{pending ? "Saving" : "Save place"}</button>;
}

export function PlaceForm({ action, places, current }: { action: (fd: FormData) => Promise<void>; places: Place[]; current: string | null }) {
  const start = current && places.some((p) => p.id === current) ? current : places[0]?.id ?? "new";
  const [place, setPlace] = useState(start);
  const [placeName, setPlaceName] = useState(places.find((p) => p.id === start)?.name ?? "");
  // A new pin starts at the current place, so it can be moved a little.
  const pin = places.find((p) => p.id === current);
  return (
    <form action={action} className="space-y-4">
      <PlaceChooser places={places} place={place} setPlace={setPlace} placeName={placeName} setPlaceName={setPlaceName} initialPin={pin ? [pin.lon, pin.lat] : null} />
      <div className="flex flex-wrap gap-2">
        <Submit />
        <a href="/orders" className="btn-secondary">Cancel</a>
      </div>
    </form>
  );
}
