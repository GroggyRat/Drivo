// Valhalla returns shapes as encoded polylines with 6 digits of precision.
export function decodePolyline6(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

export function encodePolyline6(coords: [number, number][]): string {
  let out = "";
  let prevLat = 0;
  let prevLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * 1e6);
    const lo = Math.round(lon * 1e6);
    out += enc(la - prevLat) + enc(lo - prevLon);
    prevLat = la;
    prevLon = lo;
  }
  return out;
}
