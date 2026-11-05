import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";

const SUPABASE_DIR = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(SUPABASE_DIR, "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

function baseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set. Run `npm run test:db`, which starts a throwaway Postgres for you.");
  }
  return url;
}

/**
 * Creates a fresh database, loads the Supabase stand-in and every migration
 * (and the seed when asked), and returns a superuser client connected to it.
 */
export async function createTestDatabase(options: { seed?: boolean } = {}) {
  const admin = new pg.Client({ connectionString: baseUrl() });
  await admin.connect();
  const name = `drivo_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${name}`);

  const url = new URL(baseUrl());
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();

  await client.query(readFileSync(path.join(import.meta.dirname, "supabase-shim.sql"), "utf8"));
  for (const file of migrationFiles()) {
    try {
      await client.query(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${path.basename(file)} failed: ${(error as Error).message}`);
    }
  }
  if (options.seed) {
    await client.query(readFileSync(path.join(SUPABASE_DIR, "seed.sql"), "utf8"));
  }

  return {
    client,
    async drop() {
      await client.end();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

type Who = { role: "authenticated"; userId: string } | { role: "anon" } | { role: "service_role" };

/**
 * Runs queries the way Supabase's API would for the given caller: switches to
 * the matching database role and sets the JWT claims that auth.uid() and
 * auth.role() read. Everything is rolled back afterwards unless `commit`.
 */
export async function as<T>(
  client: pg.Client,
  who: Who,
  fn: (q: pg.Client) => Promise<T>,
  options: { commit?: boolean } = {},
): Promise<T> {
  const claims = who.role === "authenticated" ? { sub: who.userId, role: "authenticated" } : { role: who.role };
  await client.query("begin");
  try {
    await client.query(`set local role ${who.role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await fn(client);
    await client.query(options.commit ? "commit" : "rollback");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export const asUser = <T>(client: pg.Client, userId: string, fn: (q: pg.Client) => Promise<T>, options?: { commit?: boolean }) =>
  as(client, { role: "authenticated", userId }, fn, options);

export const asService = <T>(client: pg.Client, fn: (q: pg.Client) => Promise<T>, options?: { commit?: boolean }) =>
  as(client, { role: "service_role" }, fn, options);

export const asAnon = <T>(client: pg.Client, fn: (q: pg.Client) => Promise<T>) => as(client, { role: "anon" }, fn);

/** Every base table in public. */
export async function publicTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'spatial_ref_sys' order by 1",
  );
  return rows.map((r) => r.table_name);
}

export const count = async (q: pg.Client, sql: string, params: unknown[] = []) =>
  Number((await q.query(sql, params)).rows[0].count);

/** Expects a permission error: RLS refusal, missing grant or a function's "Not allowed". */
export async function expectDenied(promise: Promise<unknown>) {
  await (await import("vitest")).expect(promise).rejects.toMatchObject({ code: "42501" });
}
