import pg from "pg";
import { getDatabase } from "@netlify/database";
import { env } from "./env";

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

let instance: Db | null = null;

/** Tests / local dev can inject an embedded database (PGlite). */
export function setDb(db: Db | null) { instance = db; }

/**
 * Production: Netlify Database (auto-provisioned Postgres) via @netlify/database.
 * DATABASE_URL overrides it (e.g. Supabase/Neon connection string).
 */
export function getDb(): Db {
  if (instance) return instance;
  const url = env("DATABASE_URL");
  if (url) {
    // SSL only when requested in the URL (sslmode=require), e.g. Supabase/Neon; local/Docker Postgres runs without it.
    const pool = new pg.Pool({ connectionString: url, max: Number(env("DB_POOL_MAX") ?? 10), ssl: /sslmode=(require|verify)|ssl=true/.test(url) ? { rejectUnauthorized: false } : undefined });
    instance = { query: (t, p) => pool.query(t, p as unknown[]) as never };
  } else {
    const conn = getDatabase();
    const pool = conn.pool as unknown as { query(t: string, p?: unknown[]): Promise<{ rows: unknown[] }> };
    instance = { query: (t, p) => pool.query(t, p) as never };
  }
  return instance;
}

export async function one<T>(text: string, params?: unknown[]): Promise<T | null> {
  const r = await getDb().query<T>(text, params);
  return r.rows[0] ?? null;
}
export async function many<T>(text: string, params?: unknown[]): Promise<T[]> {
  return (await getDb().query<T>(text, params)).rows;
}

/** Simple TTL lock backed by the rate_limits table (works across serverless instances). */
export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const r = await many<{ key: string }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET window_start = now(), count = 1
       WHERE rate_limits.window_start < now() - make_interval(secs => $2)
     RETURNING key`, ["lock:" + key, ttlSeconds]);
  return r.length > 0;
}
export async function releaseLock(key: string) {
  await getDb().query(`DELETE FROM rate_limits WHERE key = $1`, ["lock:" + key]);
}
