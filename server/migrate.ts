/**
 * Migration runner for self-hosted PostgreSQL (Netlify applies the same files automatically on deploy).
 * Applies netlify/database/migrations/*.sql in order, once each, under an advisory lock.
 *   --baseline  mark every migration as applied without running it (use after restoring a dump from Netlify).
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

export async function migrate(connectionString: string, opts: { dir?: string; baseline?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const dir = path.resolve(opts.dir ?? "netlify/database/migrations");
  const client = new pg.Client({ connectionString, ssl: /sslmode=require|ssl=true/.test(connectionString) ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(424242)`);
    await client.query(`CREATE TABLE IF NOT EXISTS _utilmo_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>(`SELECT name FROM _utilmo_migrations`)).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      if (!opts.baseline) {
        await client.query("BEGIN");
        try { await client.query(fs.readFileSync(path.join(dir, f), "utf8")); await client.query(`INSERT INTO _utilmo_migrations (name) VALUES ($1)`, [f]); await client.query("COMMIT"); }
        catch (e) { await client.query("ROLLBACK"); throw new Error(`Migration ${f} failed: ${(e as Error).message}`); }
        log(`applied ${f}`);
      } else { await client.query(`INSERT INTO _utilmo_migrations (name) VALUES ($1)`, [f]); log(`baselined ${f}`); }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(424242)`).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && /migrate\.(ts|mjs|js)$/.test(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
  migrate(url, { baseline: process.argv.includes("--baseline") }).then(() => console.log("migrations: up to date")).catch((e) => { console.error(e.message); process.exit(1); });
}
