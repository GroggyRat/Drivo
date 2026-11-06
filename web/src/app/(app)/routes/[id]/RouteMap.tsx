"use client";

import MapView from "@/components/MapView";

export function RouteMap({ depot, stops, line }: {
  depot: { name: string; position: [number, number] };
  stops: { id: string; sequence: number; name: string; position: [number, number]; done: boolean }[];
  line: [number, number][];
}) {
  return (
    <MapView
      height={460}
      fitKey="route"
      ariaLabel="Route map"
      markers={[
        { id: "depot", position: depot.position, kind: "depot", text: "D", label: `Depot: ${depot.name}` },
        ...stops.map((s) => ({ id: s.id, position: s.position, kind: s.done ? ("done" as const) : ("stop" as const), text: String(s.sequence), label: `${s.sequence}. ${s.name}` })),
      ]}
      lines={line.length > 1 ? [{ id: "route", coordinates: line }] : []}
    />
  );
}
