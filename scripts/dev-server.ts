/**
 * Local server: serves dist/ and mounts the same API handlers as the Netlify Functions, backed by an
 * embedded Postgres (PGlite, persisted in .data/). AI calls use real provider credentials (AI_API_KEY or
 * ANTHROPIC_API_KEY). Set UTILMO_FAKE_LLM=1 to use the clearly-labelled scripted TEST DOUBLE instead.
 */
import fs from "node:fs";
process.env.UTILMO_DEV = "1";
const { setDb } = await import("../server/db");
const { createLocalDb } = await import("../server/pglite");
const { setLLMOverride } = await import("../server/ai");

const PORT = Number(process.env.PORT ?? 8888);
const dataDir = process.env.UTILMO_DB_DIR ?? ".data/pglite";
if (dataDir !== "memory") fs.mkdirSync(dataDir, { recursive: true });
const { db } = await createLocalDb(dataDir === "memory" ? undefined : dataDir);
setDb(db);
if (process.env.UTILMO_FAKE_LLM === "1") {
  const { fakeLLM } = await import("../tests/helpers/fake-llm");
  setLLMOverride(fakeLLM());
  console.log("⚠ Using the scripted TEST DOUBLE LLM (UTILMO_FAKE_LLM=1) — replies are NOT real AI.");
}

const { createNodeServer } = await import("../server/node-server");
createNodeServer({ staticDir: "dist" }).listen(PORT, () => console.log(`Utilmo AI dev server: http://localhost:${PORT}  (admin: /admin, setup token: dev-setup-token)`));
