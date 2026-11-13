import type { MapMarker } from "@/components/MapView";

// Road alerts: an add-on the platform turns on per company. Reports stay
// inside the company and drivers do not see who made them.

export type RoadAlertKind = "hazard" | "police" | "speed_camera";

export type RoadAlert = {
  id: string;
  kind: RoadAlertKind;
  lon: number;
  lat: number;
  reported_at: string;
  confirmations: number;
  mine: boolean;
  voted: boolean;
};

export const ROAD_ALERT_KINDS: RoadAlertKind[] = ["hazard", "police", "speed_camera"];

export const ROAD_ALERT_LABEL: Record<RoadAlertKind, string> = {
  hazard: "Hazard",
  police: "Police checkpoint",
  speed_camera: "Speed camera",
};

/** What the company pays for the add-on, shown to the platform owner and in Settings. */
export const ROAD_ALERTS_PRICE = "FJD 25 a month";

const MARKER_KIND: Record<RoadAlertKind, NonNullable<MapMarker["kind"]>> = {
  hazard: "alert_hazard",
  police: "alert_police",
  speed_camera: "alert_camera",
};

export function roadAlertMarker(a: RoadAlert, label: string, onClick?: () => void): MapMarker {
  return { id: `road-${a.id}`, position: [a.lon, a.lat], kind: MARKER_KIND[a.kind], label, onClick };
}
