import http from "node:http";
import { setDb, type Db } from "../../server/db";
import { createLocalDb } from "../../server/pglite";
import { setLLMOverride } from "../../server/ai";
import { handleChat, handleSessionGet } from "../../server/public-api";
import { handleAdmin } from "../../server/admin-api";
import { invalidateAssistantCache } from "../../server/tenant";
import { fakeLLM } from "./fake-llm";
import type { ChatStreamEvent } from "../../packages/shared/src/protocol";

export const ORIGIN = "http://localhost:5173";

export async function setupHarness(): Promise<{ db: Db; bg: Promise<unknown>[] }> {
  const { db } = await createLocalDb();
  setDb(db);
  setLLMOverride(fakeLLM());
  invalidateAssistantCache();
  return { db, bg: [] };
}

export async function chat(bg: Promise<unknown>[], message: string, token: string | null, extra: Record<string, unknown> = {}, origin = ORIGIN) {
  const clientMessageId = (extra.clientMessageId as string) ?? "m" + Math.random().toString(36).slice(2, 12) + Date.now();
  const req = new Request("http://localhost:8888/api/chat", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ assistantId: "utilmo", sessionToken: token, message, clientMessageId, ...extra }) });
  const res = await handleChat(req, { ip: `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, waitUntil: (p) => bg.push(p) });
  const text = await res.text();
  const events: ChatStreamEvent[] = res.headers.get("content-type")?.includes("ndjson") ? text.trim().split("\n").map((l) => JSON.parse(l)) : [];
  await Promise.all(bg.splice(0));
  const reply = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
  const session = events.find((e) => e.type === "session") as { sessionToken: string; conversationId: string } | undefined;
  const actions = events.filter((e) => e.type === "actions").flatMap((e) => (e as { actions: { type: string }[] }).actions);
  const done = events.find((e) => e.type === "done") as { state: string; language: string } | undefined;
  return { status: res.status, events, reply, token: session?.sessionToken ?? token, conversationId: session?.conversationId, actions, done, raw: text, clientMessageId };
}

export async function restore(token: string) {
  const r = await handleSessionGet(new Request(`http://localhost:8888/api/session?assistantId=utilmo&token=${encodeURIComponent(token)}`, { headers: { origin: ORIGIN } }));
  return r.json();
}

let cookie = "";
export async function admin(path: string, opts: { method?: string; body?: unknown; csrf?: boolean; cookie?: string } = {}) {
  const headers: Record<string, string> = { origin: "http://localhost:8888", cookie: opts.cookie ?? cookie };
  if (opts.csrf !== false) headers["x-requested-with"] = "utilmo-admin";
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await handleAdmin(new Request("http://localhost:8888/api/admin" + path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }), { ip: "10.0.0.2" });
  const set = res.headers.get("set-cookie");
  if (set && !opts.cookie) cookie = set.split(";")[0];
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, data: ct.includes("json") ? await res.json() : await res.text(), headers: res.headers };
}
export function adminCookie() { return cookie; }

/** Local webhook receiver used to verify signed deliveries and retry behaviour. */
export function webhookServer(statusFor: () => number) {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { received.push({ headers: req.headers, body: b }); res.writeHead(statusFor()); res.end("ok"); });
  });
  return new Promise<{ url: string; received: typeof received; close: () => void }>((resolve) => server.listen(0, () => {
    const port = (server.address() as { port: number }).port;
    resolve({ url: `http://localhost:${port}/hook`, received, close: () => server.close() });
  }));
}
