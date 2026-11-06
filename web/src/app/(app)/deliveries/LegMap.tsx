"use client";

import MapView from "@/components/MapView";

export function LegMap({ from, fromName, to, toName, routeLine }: {
  from: [number, number] | null;
  fromName: string;
  to: [number, number];
  toName: string;
  routeLine: [number, number][];
}) {
  return (
    <MapView
      height={220}
      fitKey={`${to.join()}`}
      ariaLabel={`Leg from ${fromName} to ${toName}`}
      markers={[
        ...(from ? [{ id: "from", position: from, kind: "done" as const, label: `From ${fromName}` }] : []),
        { id: "to", position: to, kind: "selected", label: toName },
      ]}
      lines={[
        ...(routeLine.length > 1 ? [{ id: "route", coordinates: routeLine, color: "#94a3b8", width: 3, opacity: 0.6 }] : []),
        ...(from ? [{ id: "leg", coordinates: [from, to], color: "#2563eb", width: 4 }] : []),
      ]}
    />
  );
}
