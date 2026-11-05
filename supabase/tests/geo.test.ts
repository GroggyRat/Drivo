import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestDatabase } from "./helpers";

// Fiji crosses the 180 degree meridian. Taveuni is cut by it, and most of
// the Lau Group is east of it (negative longitudes). These checks make sure
// distances, the duplicate check and route lines work across the line.

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = db.client;
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

const point = (lon: number, lat: number) =>
  `extensions.st_setsrid(extensions.st_makepoint(${lon}, ${lat}), 4326)::extensions.geography`;

const scalar = async (sql: string) => Object.values((await client.query(sql)).rows[0])[0] as number;

describe("across the 180 degree meridian", () => {
  it("measures Waiyevo (west of the line) to Matei (east of it) on Taveuni as about 15 km, not the long way round", async () => {
    const metres = await scalar(`select extensions.st_distance(${point(179.98, -16.79)}, ${point(-179.88, -16.69)})`);
    expect(metres).toBeGreaterThan(14_000);
    expect(metres).toBeLessThan(20_000);
  });

  it("finds a point 20 m away across the line within the 30 m duplicate radius", async () => {
    // 20 m east of 179.99990 at -16.8 crosses into negative longitude.
    const within = await scalar(`select extensions.st_dwithin(${point(179.9999, -16.8)}, ${point(-179.99991, -16.8)}, 30)`);
    expect(within).toBe(true);
  });

  it("measures a route line from Suva to Lakeba in the Lau Group as one short crossing, not around the world", async () => {
    const metres = await scalar(`
      select extensions.st_length(extensions.st_setsrid(
        extensions.st_makeline(extensions.st_makepoint(178.44, -18.14), extensions.st_makepoint(-178.80, -18.23)), 4326
      )::extensions.geography)`);
    // About 290 km.
    expect(metres).toBeGreaterThan(250_000);
    expect(metres).toBeLessThan(330_000);
  });
});
