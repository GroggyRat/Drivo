// Tiny PNG writer for demo images (proof photos and signatures) in local
// development. No dependencies beyond zlib.
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** pixel(x, y) returns [r, g, b]. */
export function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A shopfront-like picture: sky, wall, door and stacked cartons. */
export function demoPhoto(seed = 1) {
  const hue = (seed * 47) % 255;
  return png(320, 240, (x, y) => {
    if (y < 70) return [200, 220, 240];
    if (x > 30 && x < 290 && y > 60 && y < 80) return [hue, 90, 60];
    if (x > 130 && x < 190 && y > 110) return [70, 60, 55];
    if (x > 210 && x < 280 && y > 150 && ((Math.floor((x - 210) / 35) + Math.floor((y - 150) / 30)) % 2 === 0)) return [176, 138, 92];
    if (x > 210 && x < 280 && y > 150) return [160, 122, 80];
    if (y > 220) return [120, 120, 120];
    return [235, 230, 220];
  });
}

/** A handwritten-looking signature on white. */
export function demoSignature(seed = 1) {
  return png(360, 120, (x, y) => {
    const t = x / 360;
    const yLine = 70 + 22 * Math.sin(t * 9 + seed) * Math.cos(t * 3.1) - 15 * Math.sin(t * 23 + seed * 2) * (t < 0.6 ? 1 : 0.3);
    const ink = x > 30 && x < 330 && Math.abs(y - yLine) < 2.2;
    const underline = x > 40 && x < 300 && Math.abs(y - (100 - t * 6)) < 1.2;
    return ink || underline ? [20, 30, 70] : [255, 255, 255];
  });
}
