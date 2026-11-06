"use client";

import { useRouter } from "next/navigation";
import MapView from "@/components/MapView";

type Loc = { id: string; name: string; type: string; status: string; lon: number; lat: number };

export function LocationsMap({ locations, height = 420, highlight }: { locations: Loc[]; height?: number; highlight?: string }) {
  const router = useRouter();
  return (
    <MapView
      height={height}
      fitKey={`${locations.length}-${highlight ?? ""}`}
      ariaLabel="Locations map"
      markers={locations.map((l) => ({
        id: l.id,
        position: [l.lon, l.lat],
        label: `${l.name} (${l.status === "pending" ? "needs review" : l.type})`,
        kind: l.id === highlight ? "selected" : l.status === "pending" ? "pending" : l.type === "hazard" ? "hazard" : l.type === "fuel" ? "fuel" : l.type === "depot" ? "depot" : "shop",
        onClick: () => router.push(`/locations/${l.id}`),
      }))}
    />
  );
}
