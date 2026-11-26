/**
 * Self-hosted production server (no Netlify): PostgreSQL via DATABASE_URL, AI via AI_API_KEY.
 * Serves the demo page, admin, widget and API on one port; runs maintenance every 10 minutes.
 *   npm run build && npm run build:server && node dist-server/server.mjs
 */
import { createNodeServer } from "./node-server";
import { migrate } from "./migrate";
import { runMaintenance } from "./maintenance";
import { ensureSecrets, env } from "./env";

const PORT = Number(env("PORT") ?? 8080);
const DATABASE_URL = env("DATABASE_URL");
if (!DATABASE_URL) { console.error("DATABASE_URL is required (PostgreSQL 15+ with the pgvector extension recommended)."); process.exit(1); }
if (!env("AI_API_KEY") && !env("ANTHROPIC_API_KEY") && !env("OPENAI_API_KEY")) console.warn("⚠ No AI key set (AI_API_KEY). The chat will not be able to answer until it is configured.");

if (env("RUN_MIGRATIONS") !== "false") await migrate(DATABASE_URL, { log: (m) => console.log(`[migrate] ${m}`) });
await ensureSecrets();

const server = createNodeServer({ staticDir: env("STATIC_DIR") ?? "dist", trustProxy: env("TRUST_PROXY") !== "false" });
server.listen(PORT, () => console.log(`Utilmo AI listening on :${PORT}`));

// Scheduled jobs (webhook/e-mail retries, retention purge, embeddings): every 10 minutes.
const tick = () => runMaintenance(60_000).then((r) => console.log("[maintenance]", JSON.stringify(r))).catch((e) => console.error("[maintenance] failed", e));
setTimeout(tick, 30_000);
setInterval(tick, 10 * 60_000);

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { console.log(`${sig} received, shutting down`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000); });
