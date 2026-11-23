/**
 * Local server: serves dist/ and mounts the same API handlers as the Netlify Functions, backed by an
 * embedded Postgres (PGlite, persisted in .data/). AI calls use real provider credentials (AI_API_KEY or
 * ANTHROPIC_API_KEY). Set UTILMO_FAKE_LLM=1 to use the clearly-labelled scripted TEST DOUBLE instead.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
process.env.UTILMO_DEV = "1";
const { setDb } = await import("../server/db");
const { createLocalDb } = await import("../server/pglite");
const { handleChat, handleConfig, handleEvent, handleSessionDelete, handleSessionGet, preflight } = await import("../server/public-api");
const { handleAdmin } = await import("../server/admin-api");
const { crawlSource } = await import("../server/knowledge");
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

const triggerCrawl = async (a: { id: string; organizationId: string }, sourceId: string) => {
  void crawlSource(a, sourceId, (m) => console.log("[crawl]", m)).catch((e) => console.error("[crawl]", e));
};
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
      const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body, duplex: "half" } as RequestInit);
      const ctx = { ip: req.socket.remoteAddress ?? "127.0.0.1", waitUntil: (p: Promise<unknown>) => void p, triggerCrawl };
      let response: Response;
      if (req.method === "OPTIONS") response = preflight(request);
      else if (url.pathname === "/api/chat") response = await handleChat(request, ctx);
      else if (url.pathname === "/api/session") response = req.method === "DELETE" ? await handleSessionDelete(request) : await handleSessionGet(request);
      else if (url.pathname === "/api/widget-config") response = await handleConfig(request);
      else if (url.pathname === "/api/event") response = await handleEvent(request, ctx);
      else if (url.pathname.startsWith("/api/admin")) response = await handleAdmin(request, ctx);
      else response = new Response("not found", { status: 404 });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) { const reader = response.body.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } }
      return res.end();
    }
    let file = path.join("dist", decodeURIComponent(url.pathname));
    if (url.pathname.startsWith("/admin")) file = path.join("dist", "admin", "index.html");
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end("error");
  }
}).listen(PORT, () => console.log(`Utilmo AI dev server: http://localhost:${PORT}  (admin: /admin, setup token: dev-setup-token)`));
