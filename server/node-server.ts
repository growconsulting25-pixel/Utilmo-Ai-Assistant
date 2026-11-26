/**
 * Plain Node.js HTTP server exposing the same routes as the Netlify Functions.
 * Used by the local dev server and by self-hosting (server/standalone.ts).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handleChat, handleConfig, handleEvent, handleSessionDelete, handleSessionGet, preflight } from "./public-api";
import { handleAdmin } from "./admin-api";
import { handleBookingWebhook } from "./booking";
import { crawlSource } from "./knowledge";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" };

export interface NodeServerOptions { staticDir: string; trustProxy?: boolean; log?: (m: string) => void }

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function createNodeServer(opts: NodeServerOptions): http.Server {
  const log = opts.log ?? ((m: string) => console.log(m));
  const staticRoot = path.resolve(opts.staticDir);
  const triggerCrawl = async (a: { id: string; organizationId: string }, sourceId: string) => {
    // No function time limit on a server: crawl in-process, in the background.
    void crawlSource(a, sourceId, (m) => log(`[crawl] ${m}`)).catch((e) => log(`[crawl] failed ${String(e)}`));
  };

  return http.createServer(async (req, res) => {
    const proto = opts.trustProxy ? String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0] : "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost");
    const url = new URL(req.url ?? "/", `${proto}://${host}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = []; let size = 0;
          req.on("data", (d: Buffer) => { size += d.length; if (size > 6_000_000) { reject(new Error("payload too large")); req.destroy(); } else chunks.push(d); });
          req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
        });
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        const request = new Request(url, { method: req.method, headers, body, duplex: "half" } as RequestInit);
        const ctx = { ip: clientIp(req, !!opts.trustProxy), waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), triggerCrawl };
        let response: Response;
        const p = url.pathname;
        if (req.method === "OPTIONS" && !p.startsWith("/api/admin")) response = preflight(request);
        else if (p === "/api/chat") response = await handleChat(request, ctx);
        else if (p === "/api/session") response = req.method === "DELETE" ? await handleSessionDelete(request) : await handleSessionGet(request);
        else if (p === "/api/widget-config") response = await handleConfig(request);
        else if (p === "/api/event") response = await handleEvent(request, ctx);
        else if (p.startsWith("/api/admin")) response = await handleAdmin(request, ctx);
        else if (p.startsWith("/api/booking/webhook/") && req.method === "POST") response = await handleBookingWebhook(request, p.split("/").pop());
        else response = new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
        const outHeaders: Record<string, string> = { ...SECURITY_HEADERS };
        response.headers.forEach((v, k) => { outHeaders[k] = v; });
        const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
        res.writeHead(response.status, { ...outHeaders, ...(cookies.length ? { "set-cookie": cookies } : {}) } as http.OutgoingHttpHeaders);
        if (response.body) { const reader = response.body.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } }
        return res.end();
      }
      // Static files (demo page, admin SPA, widget, brand assets).
      let rel = decodeURIComponent(url.pathname);
      if (rel.startsWith("/admin")) rel = rel.match(/\.[a-z0-9]+$/i) ? rel : "/admin/index.html";
      let file = path.join(staticRoot, rel);
      if (!file.startsWith(staticRoot)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      if (!fs.existsSync(file)) { res.writeHead(404, SECURITY_HEADERS); return res.end("not found"); }
      const headers: Record<string, string> = { ...SECURITY_HEADERS, "content-type": MIME[path.extname(file)] ?? "application/octet-stream" };
      if (rel === "/widget.js") Object.assign(headers, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" });
      else if (rel.startsWith("/widget/") || rel.startsWith("/brand/")) Object.assign(headers, { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" });
      else if (rel.startsWith("/assets/")) headers["cache-control"] = "public, max-age=31536000, immutable";
      if (rel.startsWith("/admin")) Object.assign(headers, { "x-frame-options": "DENY", "x-robots-tag": "noindex, nofollow" });
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      log(`[server] error ${e instanceof Error ? e.stack : String(e)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end("error");
    }
  });
}
