// Geography helpers. Fiji crosses the 180 degree meridian, so longitudes
// east of it (Lau Group, eastern Taveuni) are negative. For drawing and
// fitting the map we shift them to 180..360 so lines do not wrap the world.

export type LngLat = [number, number];

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. Works across the 180 degree meridian. */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Longitude for drawing in a Fiji-centred view: -180..-90 becomes 180..270. */
export function fijiLng(lng: number): number {
  return lng < -90 ? lng + 360 : lng;
}

export function toFijiView(points: LngLat[]): LngLat[] {
  return points.map(([lng, lat]) => [fijiLng(lng), lat]);
}

/** Bounds [[w, s], [e, n]] in the Fiji-centred view. */
export function boundsOf(points: LngLat[]): [LngLat, LngLat] | null {
  if (!points.length) return null;
  const view = toFijiView(points);
  const lngs = view.map((p) => p[0]);
  const lats = view.map((p) => p[1]);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

export const FIJI_CENTRE: LngLat = [178.45, -18.1];
export const SUVA: LngLat = [178.4419, -18.1416];
