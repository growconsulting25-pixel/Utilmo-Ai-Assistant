import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import type { Db } from "./db";

/** Embedded Postgres for local development and automated tests (same migrations as production). */
export async function createLocalDb(dataDir?: string): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite({ dataDir, extensions: { vector } });
  await pg.exec(`CREATE TABLE IF NOT EXISTS _local_migrations (name text PRIMARY KEY)`);
  const dir = path.resolve("netlify/database/migrations");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const done = await pg.query(`SELECT 1 FROM _local_migrations WHERE name = $1`, [f]);
    if (done.rows.length) continue;
    await pg.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    await pg.query(`INSERT INTO _local_migrations (name) VALUES ($1)`, [f]);
  }
  let chain: Promise<unknown> = Promise.resolve();
  const db: Db = {
    // PGlite is single-connection: serialise queries to mimic a pool safely.
    query: (text, params) => {
      const run = chain.then(() => pg.query(text, params as unknown[]));
      chain = run.catch(() => undefined);
      return run as never;
    },
  };
  return { db, pg };
}
