import { z } from "zod";
import { SettingsSchema } from "../packages/shared/src/settings";
import { audit, login, requireAdmin, sessionCookie, setupTokenMatches, validatePassword, type AdminSession } from "./admin-auth";
import { encrypt, hashPassword, sha256 } from "./crypto";
import { getDb, many, one } from "./db";
import { clientIp, errorResponse, HttpError, json, readJson } from "./http";
import { bootstrapAssistant, bumpKnowledgeVersion, indexDocument, ingestDocument, listDocuments } from "./knowledge";
import { rateLimit } from "./ratelimit";
import { searchKnowledge } from "./retrieval";
import { getEmbedder } from "./ai";
import { invalidateAssistantCache, loadAssistantById, type AssistantCtx } from "./tenant";
import { assertSafeDestination, attemptDelivery, sendTestEvent } from "./webhooks";
import { ipHash } from "./crypto";

export interface AdminCtx { ip?: string; triggerCrawl?: (a: AssistantCtx, sourceId: string) => Promise<void>; waitUntil?: (p: Promise<unknown>) => void }

type Handler = (req: Request, p: Record<string, string>, s: AdminSession, url: URL, ctx: AdminCtx) => Promise<Response>;
interface Route { method: string; pattern: RegExp; keys: string[]; role: "viewer" | "editor" | "admin" | "owner"; h: Handler }
const routes: Route[] = [];
function route(method: string, path: string, role: Route["role"], h: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, pattern, keys, role, h });
}

async function assistantFor(s: AdminSession, url: URL): Promise<AssistantCtx> {
  const id = url.searchParams.get("assistant");
  const row = id
    ? await one<{ id: string }>(`SELECT id FROM assistants WHERE id = $1 AND organization_id = $2`, [id, s.org])
    : await one<{ id: string }>(`SELECT id FROM assistants WHERE organization_id = $1 ORDER BY created_at LIMIT 1`, [s.org]);
  if (!row) throw new HttpError(404, "assistant_not_found");
  const a = await loadAssistantById(s.org, row.id);
  if (!a) throw new HttpError(404, "assistant_not_found");
  return a;
}
const uuid = z.string().uuid();
const page = (url: URL) => ({ limit: Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50))), offset: Math.max(0, Number(url.searchParams.get("offset") ?? 0)) });
async function body<T>(req: Request, schema: z.ZodType<T>, max = 256 * 1024): Promise<T> {
  const r = schema.safeParse(await readJson(req, max));
  if (!r.success) throw new HttpError(400, "invalid_request", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400));
  return r.data;
}

// ------------------------------------------------------------------ dashboard
route("GET", "/dashboard", "viewer", async (_req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
  const args = [a.id, days];
  const since = `now() - make_interval(days => $2)`;
  const [totals] = await many<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM conversations WHERE assistant_id = $1 AND created_at > ${since} AND message_count > 0) AS conversations,
      (SELECT count(DISTINCT visitor_id)::int FROM conversations WHERE assistant_id = $1 AND created_at > ${since} AND message_count > 0) AS visitors,
      (SELECT count(*)::int FROM leads WHERE assistant_id = $1 AND created_at > ${since} AND status <> 'support') AS leads,
      (SELECT count(*)::int FROM leads WHERE assistant_id = $1 AND created_at > ${since} AND status = 'qualified') AS qualified,
      (SELECT count(*)::int FROM analytics_events WHERE assistant_id = $1 AND created_at > ${since} AND event = 'booking_clicked') AS booking_clicks,
      (SELECT count(*)::int FROM bookings WHERE assistant_id = $1 AND created_at > ${since} AND status = 'confirmed') AS bookings_confirmed,
      (SELECT count(*)::int FROM leads WHERE assistant_id = $1 AND created_at > ${since} AND (qualification->>'demo_interest') = 'yes') AS demo_requests,
      (SELECT count(*)::int FROM support_tickets WHERE assistant_id = $1 AND created_at > ${since}) AS support_requests,
      (SELECT count(*)::int FROM conversations WHERE assistant_id = $1 AND created_at > ${since} AND escalation_status <> 'none') AS human_requests,
      (SELECT count(*)::int FROM unanswered_questions WHERE assistant_id = $1 AND created_at > ${since} AND status = 'open') AS unanswered,
      (SELECT coalesce(sum(requests),0)::int FROM usage_daily WHERE assistant_id = $1 AND day > (now() - make_interval(days => $2))::date) AS ai_replies,
      (SELECT coalesce(sum(input_tokens),0)::bigint FROM usage_daily WHERE assistant_id = $1 AND day > (now() - make_interval(days => $2))::date) AS input_tokens,
      (SELECT coalesce(sum(output_tokens),0)::bigint FROM usage_daily WHERE assistant_id = $1 AND day > (now() - make_interval(days => $2))::date) AS output_tokens,
      (SELECT coalesce(sum(est_cost_usd),0)::float FROM usage_daily WHERE assistant_id = $1 AND day > (now() - make_interval(days => $2))::date) AS est_cost_usd,
      (SELECT CASE WHEN sum(requests) > 0 THEN (sum(total_latency_ms) / sum(requests))::int ELSE 0 END FROM usage_daily WHERE assistant_id = $1 AND day > (now() - make_interval(days => $2))::date) AS avg_latency_ms`, args);
  const services = await many(`SELECT service_key AS key, count(*)::int AS n FROM conversation_recommendations r JOIN conversations c ON c.id = r.conversation_id WHERE c.assistant_id = $1 AND r.created_at > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, args);
  const interests = await many(`SELECT unnest(intents) AS category, count(*)::int AS n FROM conversations WHERE assistant_id = $1 AND created_at > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, args);
  const questions = await many(`SELECT left(content, 140) AS question, count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.assistant_id = $1 AND m.role = 'user' AND m.created_at > ${since} AND length(m.content) > 12 AND m.content LIKE '%?%' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`, args);
  const unanswered = await many(`SELECT id, question, language, created_at FROM unanswered_questions WHERE assistant_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 10`, [a.id]);
  const daily = await many(`SELECT d::date AS day,
      (SELECT count(*)::int FROM conversations WHERE assistant_id = $1 AND created_at::date = d::date AND message_count > 0) AS conversations,
      (SELECT count(*)::int FROM leads WHERE assistant_id = $1 AND created_at::date = d::date AND status <> 'support') AS leads
    FROM generate_series((now() - make_interval(days => $2))::date, now()::date, interval '1 day') d ORDER BY 1`, args);
  const conv = totals.conversations || 0;
  const { env: envGet } = await import("./env");
  const usdToCad = Number(envGet("USD_TO_CAD") ?? 1.38) || 1.38;
  return json({ days, usd_to_cad: usdToCad, totals: { ...totals, est_cost_cad: Math.round(Number(totals.est_cost_usd ?? 0) * usdToCad * 100) / 100, conversion_rate: conv ? Math.round((totals.leads / conv) * 1000) / 10 : 0 }, services, interests, questions, unanswered, daily, demoData: false });
});

// ------------------------------------------------------------------ conversations
route("GET", "/conversations", "viewer", async (_req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const { limit, offset } = page(url);
  const q = url.searchParams.get("q")?.trim();
  const params: unknown[] = [a.id];
  const where = ["c.assistant_id = $1", "c.message_count > 0", "c.status <> 'deleted'"];
  if (q) { params.push(`%${q}%`); where.push(`(c.summary ILIKE $${params.length} OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content ILIKE $${params.length}) OR l.email ILIKE $${params.length} OR l.first_name ILIKE $${params.length} OR l.last_name ILIKE $${params.length})`); }
  const from = url.searchParams.get("from"); if (from) { params.push(from); where.push(`c.created_at >= $${params.length}::date`); }
  const to = url.searchParams.get("to"); if (to) { params.push(to); where.push(`c.created_at < ($${params.length}::date + 1)`); }
  const intent = url.searchParams.get("intent"); if (intent) { params.push(intent); where.push(`$${params.length} = ANY(c.intents)`); }
  const minScore = url.searchParams.get("minScore"); if (minScore) { params.push(Number(minScore)); where.push(`c.score >= $${params.length}`); }
  const esc = url.searchParams.get("escalation"); if (esc) { params.push(esc); where.push(`c.escalation_status = $${params.length}`); }
  params.push(limit, offset);
  const rows = await many(`SELECT c.id, c.state, c.status, c.language, c.intents, c.score, c.summary, c.escalation_status, c.message_count, c.created_at, c.last_message_at,
      l.id AS lead_id, l.first_name, l.last_name, l.email, l.status AS lead_status
    FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id WHERE ${where.join(" AND ")} ORDER BY coalesce(c.last_message_at, c.created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return json({ items: rows });
});
route("GET", "/conversations/:id", "viewer", async (_req, p, s) => {
  const c = await one<Record<string, unknown>>(`SELECT c.*, v.first_touch AS visitor_first_touch FROM conversations c JOIN visitors v ON v.id = c.visitor_id WHERE c.id = $1 AND c.organization_id = $2`, [uuid.parse(p.id), s.org]);
  if (!c) throw new HttpError(404, "not_found");
  const messages = await many(`SELECT id, role, content, metadata, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [p.id]);
  const lead = c.lead_id ? await one(`SELECT * FROM leads WHERE id = $1 AND organization_id = $2`, [c.lead_id, s.org]) : null;
  const tickets = await many(`SELECT id, status, priority, category, created_at FROM support_tickets WHERE conversation_id = $1`, [p.id]);
  const recs = await many(`SELECT service_key, confidence, reason, created_at FROM conversation_recommendations WHERE conversation_id = $1`, [p.id]);
  return json({ conversation: c, messages, lead, tickets, recommendations: recs });
});
route("PATCH", "/conversations/:id", "editor", async (req, p, s) => {
  const b = await body(req, z.object({ escalation_status: z.enum(["none", "requested", "ticket_created", "resolved"]).optional(), status: z.enum(["open", "completed", "handoff"]).optional() }));
  await getDb().query(`UPDATE conversations SET escalation_status = coalesce($3, escalation_status), status = coalesce($4, status), updated_at = now() WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org, b.escalation_status ?? null, b.status ?? null]);
  await audit(s.org, s.uid, "conversation.update", "conversation", p.id, b);
  return json({ ok: true });
});
route("POST", "/conversations/:id/takeover", "editor", async (req, p, s) => {
  const b = await body(req, z.object({ active: z.boolean() }));
  const me = await one<{ name: string | null; email: string }>(`SELECT name, email FROM admin_users WHERE id = $1`, [s.uid]);
  const raw = (me?.name || me?.email.split("@")[0] || "Équipe").split(/[ .]/)[0];
  const agent = raw.charAt(0).toUpperCase() + raw.slice(1);
  const c = await one<{ id: string }>(`UPDATE conversations SET human_active = $3, human_agent_name = CASE WHEN $3 THEN $4 ELSE human_agent_name END,
      escalation_status = CASE WHEN $3 AND escalation_status IN ('none','requested') THEN 'requested' ELSE escalation_status END, status = CASE WHEN $3 THEN 'handoff' ELSE 'open' END, updated_at = now()
    WHERE id = $1 AND organization_id = $2 RETURNING id`, [uuid.parse(p.id), s.org, b.active, agent]);
  if (!c) throw new HttpError(404, "not_found");
  await getDb().query(`INSERT INTO messages (organization_id, conversation_id, role, content, metadata) VALUES ($1,$2,'event',$3,$4)`,
    [s.org, p.id, b.active ? `${agent} a rejoint la conversation` : `${agent} a rendu la conversation à l'assistant`, JSON.stringify({ kind: b.active ? "agent_joined" : "agent_left", agent_name: agent })]);
  await audit(s.org, s.uid, b.active ? "conversation.takeover" : "conversation.release", "conversation", p.id);
  return json({ ok: true, agent });
});
route("POST", "/conversations/:id/messages", "editor", async (req, p, s) => {
  const b = await body(req, z.object({ content: z.string().min(1).max(4000) }));
  const c = await one<{ human_active: boolean; human_agent_name: string | null }>(`SELECT human_active, human_agent_name FROM conversations WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org]);
  if (!c) throw new HttpError(404, "not_found");
  if (!c.human_active) throw new HttpError(409, "takeover_required", "Take over the conversation first.");
  const me = await one<{ name: string | null; email: string }>(`SELECT name, email FROM admin_users WHERE id = $1`, [s.uid]);
  const agent = c.human_agent_name || (me?.name || me?.email.split("@")[0] || "Équipe").split(" ")[0];
  const m = await one<{ id: string }>(`INSERT INTO messages (organization_id, conversation_id, role, content, metadata) VALUES ($1,$2,'agent',$3,$4) RETURNING id`, [s.org, p.id, b.content, JSON.stringify({ agent_name: agent, admin_user_id: s.uid })]);
  await getDb().query(`UPDATE conversations SET message_count = message_count + 1, last_message_at = now(), updated_at = now() WHERE id = $1`, [p.id]);
  return json({ id: m!.id });
});
route("DELETE", "/conversations/:id", "admin", async (_req, p, s) => {
  await getDb().query(`DELETE FROM conversations WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org]);
  await audit(s.org, s.uid, "privacy.conversation_deleted", "conversation", p.id);
  return json({ ok: true });
});

// ------------------------------------------------------------------ leads
function leadFilters(url: URL, assistantId: string) {
  const params: unknown[] = [assistantId];
  const where = ["l.assistant_id = $1"];
  const q = url.searchParams.get("q")?.trim();
  if (q) { params.push(`%${q}%`); where.push(`(l.first_name ILIKE $${params.length} OR l.last_name ILIKE $${params.length} OR l.email ILIKE $${params.length} OR l.phone_e164 ILIKE $${params.length} OR l.city ILIKE $${params.length} OR l.brokerage ILIKE $${params.length})`); }
  const status = url.searchParams.get("status"); if (status) { params.push(status); where.push(`l.status = $${params.length}`); }
  const priority = url.searchParams.get("priority"); if (priority) { params.push(priority); where.push(`l.priority = $${params.length}`); }
  const sync = url.searchParams.get("sync"); if (sync) { params.push(sync); where.push(`l.sync_status = $${params.length}`); }
  if (url.searchParams.get("demo") === "yes") where.push(`l.qualification->>'demo_interest' = 'yes'`);
  const service = url.searchParams.get("service"); if (service) { params.push(service); where.push(`$${params.length} = ANY(l.services_interest)`); }
  const from = url.searchParams.get("from"); if (from) { params.push(from); where.push(`l.created_at >= $${params.length}::date`); }
  const to = url.searchParams.get("to"); if (to) { params.push(to); where.push(`l.created_at < ($${params.length}::date + 1)`); }
  return { params, where };
}
route("GET", "/leads", "viewer", async (_req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const { limit, offset } = page(url);
  const { params, where } = leadFilters(url, a.id);
  params.push(limit, offset);
  const rows = await many(`SELECT l.*, (SELECT id FROM conversations c WHERE c.lead_id = l.id ORDER BY created_at DESC LIMIT 1) AS conversation_id
    FROM leads l WHERE ${where.join(" AND ")} ORDER BY l.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return json({ items: rows });
});
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // CSV/formula-injection protection
  return `"${s.replace(/"/g, '""')}"`;
}
route("GET", "/leads/export.csv", "admin", async (_req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const { params, where } = leadFilters(url, a.id);
  const rows = await many<Record<string, unknown>>(`SELECT l.* FROM leads l WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC LIMIT 10000`, params);
  const cols = ["created_at", "first_name", "last_name", "email_normalized", "phone_e164", "language", "brokerage", "city", "territory", "user_type", "existing_customer", "services_interest", "status", "score", "priority", "sync_status", "summary"];
  const qcols = ["main_goal", "timeline", "current_crm", "website_status", "lead_methods", "biggest_challenge", "lead_volume", "demo_interest"];
  const lines = [[...cols, ...qcols].join(",")];
  for (const r of rows) lines.push([...cols.map((c) => csvCell(r[c])), ...qcols.map((c) => csvCell((r.qualification as Record<string, unknown>)?.[c]))].join(","));
  await audit(s.org, s.uid, "leads.export", "lead", null, { count: rows.length });
  return new Response("﻿" + lines.join("\r\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="utilmo-leads-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
});
route("GET", "/leads/:id", "viewer", async (_req, p, s) => {
  const lead = await one(`SELECT * FROM leads WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org]);
  if (!lead) throw new HttpError(404, "not_found");
  const scores = await many(`SELECT score, priority, breakdown, reasons, created_at FROM lead_scores WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 20`, [p.id]);
  const conversations = await many(`SELECT id, state, summary, created_at FROM conversations WHERE lead_id = $1 ORDER BY created_at DESC`, [p.id]);
  const deliveries = await many(`SELECT d.id, d.event, d.status, d.attempts, d.last_status_code, d.last_error, d.created_at, d.delivered_at, i.name AS integration FROM webhook_deliveries d JOIN integrations i ON i.id = d.integration_id WHERE d.organization_id = $2 AND d.payload->'lead'->>'id' = $1 ORDER BY d.created_at DESC`, [p.id, s.org]);
  const bookings = await many(`SELECT status, provider, scheduled_at, created_at FROM bookings WHERE lead_id = $1 ORDER BY created_at DESC`, [p.id]);
  return json({ lead, scores, conversations, deliveries, bookings });
});
route("PATCH", "/leads/:id", "editor", async (req, p, s) => {
  const b = await body(req, z.object({ status: z.enum(["new", "contact_captured", "qualified", "support", "disqualified", "archived"]).optional(), summary: z.string().max(2000).optional() }));
  await getDb().query(`UPDATE leads SET status = coalesce($3, status), summary = coalesce($4, summary), updated_at = now() WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org, b.status ?? null, b.summary ?? null]);
  await audit(s.org, s.uid, "lead.update", "lead", p.id, b);
  return json({ ok: true });
});
route("DELETE", "/leads/:id", "admin", async (_req, p, s) => {
  // Right to erasure: delete the lead, its conversations/messages and tickets.
  const id = uuid.parse(p.id);
  await getDb().query(`DELETE FROM support_tickets WHERE lead_id = $1 AND organization_id = $2`, [id, s.org]);
  await getDb().query(`DELETE FROM conversations WHERE lead_id = $1 AND organization_id = $2`, [id, s.org]);
  await getDb().query(`DELETE FROM webhook_deliveries WHERE organization_id = $2 AND payload->'lead'->>'id' = $1::text`, [id, s.org]);
  await getDb().query(`DELETE FROM leads WHERE id = $1 AND organization_id = $2`, [id, s.org]);
  await audit(s.org, s.uid, "privacy.lead_erased", "lead", id);
  return json({ ok: true });
});
route("POST", "/leads/:id/resync", "editor", async (_req, p, s) => {
  const r = await many<{ id: string }>(`UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = now() WHERE organization_id = $2 AND payload->'lead'->>'id' = $1 AND status IN ('failed','dead') RETURNING id`, [uuid.parse(p.id), s.org]);
  const results = [];
  for (const d of r) results.push(await attemptDelivery(d.id));
  await audit(s.org, s.uid, "lead.resync", "lead", p.id, { results });
  return json({ retried: r.length, results });
});

// ------------------------------------------------------------------ knowledge
route("GET", "/knowledge/documents", "viewer", async (_req, _p, s, url) => json({ items: await listDocuments((await assistantFor(s, url)).id) }));
route("GET", "/knowledge/documents/:id", "viewer", async (_req, p, s) => {
  const d = await one(`SELECT * FROM knowledge_documents WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org]);
  if (!d) throw new HttpError(404, "not_found");
  const versions = await many(`SELECT id, version, status, verified, updated_at FROM knowledge_documents WHERE organization_id = $3 AND assistant_id = (SELECT assistant_id FROM knowledge_documents WHERE id = $1) AND ((url IS NOT NULL AND url = $2) OR id = $1) ORDER BY version DESC`, [p.id, (d as { url: string | null }).url, s.org]);
  return json({ document: d, versions });
});
const DocBody = z.object({
  title: z.string().min(2).max(300), content: z.string().min(10).max(200_000), url: z.string().url().max(2000).nullable().optional(),
  language: z.enum(["fr", "en", "multi"]).default("fr"), collection: z.enum(["sales", "support", "both"]).default("both"),
  priority: z.number().int().min(1).max(4).default(1), doc_type: z.enum(["faq", "pricing", "service", "document", "manual", "correction"]).default("manual"),
  verified: z.boolean().default(false),
});
route("POST", "/knowledge/documents", "editor", async (req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const b = await body(req, DocBody);
  const src = await one<{ id: string }>(`SELECT id FROM knowledge_sources WHERE assistant_id = $1 AND type = 'manual' LIMIT 1`, [a.id])
    ?? await one<{ id: string }>(`INSERT INTO knowledge_sources (organization_id, assistant_id, type, name, priority) VALUES ($1,$2,'manual','Contenu interne (admin)',1) RETURNING id`, [a.organizationId, a.id]);
  const r = await ingestDocument(a, { sourceId: src!.id, title: b.title, url: b.url ?? null, language: b.language, collection: b.collection, priority: b.priority, docType: b.doc_type, content: b.content, verified: b.verified, metadata: { author: s.email }, fetchedAt: new Date().toISOString() });
  if (b.verified) await getDb().query(`UPDATE knowledge_documents SET verified_by = $2, verified_at = now() WHERE id = $1`, [r.id, s.uid]);
  await bumpKnowledgeVersion(a, `Added "${b.title}"`, s.uid);
  await audit(s.org, s.uid, "knowledge.create", "knowledge_document", r.id, { title: b.title });
  return json({ id: r.id, action: r.action });
});
route("PATCH", "/knowledge/documents/:id", "editor", async (req, p, s, url) => {
  const a = await assistantFor(s, url);
  const b = await body(req, DocBody.partial().extend({ status: z.enum(["active", "disabled"]).optional() }));
  const d = await one<Record<string, unknown>>(`SELECT * FROM knowledge_documents WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org]);
  if (!d) throw new HttpError(404, "not_found");
  let id = p.id;
  if (b.content && b.content !== d.content) {
    // Content edits create a new version; the old one is kept as superseded history.
    await getDb().query(`UPDATE knowledge_documents SET status = 'superseded', updated_at = now() WHERE id = $1`, [p.id]);
    const n = await one<{ id: string }>(`INSERT INTO knowledge_documents (organization_id, assistant_id, source_id, title, url, language, collection, priority, doc_type, content, content_hash, status, verified, version, metadata, fetched_at)
      SELECT organization_id, assistant_id, source_id, coalesce($2, title), url, coalesce($3, language), coalesce($4, collection), coalesce($5, priority), doc_type, $6, $8, 'pending_index', coalesce($7, false), version + 1, metadata || '{"edited":true}'::jsonb, now()
      FROM knowledge_documents WHERE id = $1 RETURNING id`, [p.id, b.title ?? null, b.language ?? null, b.collection ?? null, b.priority ?? null, b.content, b.verified ?? null, sha256(b.content)]);
    id = n!.id;
    await indexDocument(id);
  } else {
    await getDb().query(`UPDATE knowledge_documents SET title = coalesce($2, title), collection = coalesce($3, collection), priority = coalesce($4, priority), status = coalesce($5, status), verified = coalesce($6, verified), updated_at = now() WHERE id = $1`,
      [p.id, b.title ?? null, b.collection ?? null, b.priority ?? null, b.status ?? null, b.verified ?? null]);
  }
  if (b.verified) await getDb().query(`UPDATE knowledge_documents SET verified_by = $2, verified_at = now() WHERE id = $1`, [id, s.uid]);
  await bumpKnowledgeVersion(a, `Updated document ${String(d.title).slice(0, 80)}`, s.uid);
  await audit(s.org, s.uid, "knowledge.update", "knowledge_document", id, { fields: Object.keys(b) });
  return json({ id });
});
route("DELETE", "/knowledge/documents/:id", "admin", async (_req, p, s, url) => {
  const a = await assistantFor(s, url);
  await getDb().query(`DELETE FROM knowledge_documents WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org]);
  await bumpKnowledgeVersion(a, "Deleted a document", s.uid);
  await audit(s.org, s.uid, "knowledge.delete", "knowledge_document", p.id);
  return json({ ok: true });
});
route("POST", "/knowledge/upload", "editor", async (req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "file_required");
  if (file.size > 4_000_000) throw new HttpError(413, "file_too_large", "Max 4 MB");
  const name = file.name.toLowerCase();
  let text: string;
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const r = await extractText(pdf, { mergePages: false });
    text = (r.text as string[]).map((t, i) => `## Page ${i + 1}\n${t}`).join("\n\n");
  } else if (/\.(md|markdown|txt)$/.test(name) || file.type.startsWith("text/")) text = await file.text();
  else throw new HttpError(415, "unsupported_type", "PDF, TXT or Markdown only");
  if (text.trim().length < 20) throw new HttpError(422, "empty_document", "No extractable text (scanned PDFs need OCR first).");
  const collection = (form.get("collection") as string) || "both";
  const priority = Number(form.get("priority") ?? 2);
  const verified = form.get("verified") === "true";
  const src = await one<{ id: string }>(`INSERT INTO knowledge_sources (organization_id, assistant_id, type, name, collection, priority) VALUES ($1,$2,'document',$3,$4,$5) RETURNING id`, [a.organizationId, a.id, file.name.slice(0, 200), collection, priority]);
  const r = await ingestDocument(a, { sourceId: src!.id, title: (form.get("title") as string) || file.name, url: null, language: (form.get("language") as string) || "fr", collection: collection as "both", priority, docType: "document", content: text, verified, metadata: { filename: file.name, uploaded_by: s.email }, fetchedAt: new Date().toISOString() });
  await bumpKnowledgeVersion(a, `Uploaded ${file.name}`, s.uid);
  await audit(s.org, s.uid, "knowledge.upload", "knowledge_document", r.id, { filename: file.name });
  return json({ id: r.id, chars: text.length });
});
route("POST", "/knowledge/reindex", "editor", async (_req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const docs = await many<{ id: string }>(`SELECT id FROM knowledge_documents WHERE assistant_id = $1 AND status IN ('active','pending_index')`, [a.id]);
  for (const d of docs) await indexDocument(d.id);
  await getDb().query(`UPDATE knowledge_chunks SET embedding = NULL WHERE assistant_id = $1`, [a.id]).catch(() => {});
  await bumpKnowledgeVersion(a, `Reindexed ${docs.length} documents`, s.uid);
  await audit(s.org, s.uid, "knowledge.reindex", "assistant", a.id, { documents: docs.length });
  return json({ reindexed: docs.length, embeddings: getEmbedder() ? "scheduled" : "not_configured" });
});
route("POST", "/knowledge/bootstrap", "admin", async (_req, _p, s, url, ctx) => {
  const a = await assistantFor(s, url);
  const done = await bootstrapAssistant(a, ctx.triggerCrawl ? (sid) => ctx.triggerCrawl!(a, sid) : undefined);
  invalidateAssistantCache();
  return json({ imported: done });
});
route("GET", "/knowledge/sources", "viewer", async (_req, _p, s, url) => {
  const a = await assistantFor(s, url);
  return json({ items: await many(`SELECT ks.*, (SELECT count(*)::int FROM knowledge_documents d WHERE d.source_id = ks.id AND d.status = 'active') AS documents FROM knowledge_sources ks WHERE assistant_id = $1 ORDER BY created_at`, [a.id]) });
});
route("POST", "/knowledge/sources", "admin", async (req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const b = await body(req, z.object({ name: z.string().min(2).max(200), url: z.string().url(), sitemaps: z.array(z.string().url()).max(10).default([]), include_prefixes: z.array(z.string().url()).max(20).default([]), max_pages: z.number().int().min(1).max(200).default(60), collection: z.enum(["sales", "support", "both"]).default("both"), priority: z.number().int().min(2).max(4).default(3) }));
  const allowed = [...a.allowedDomains, ...(b.include_prefixes.map((p) => new URL(p).hostname))];
  if (!allowed.some((d) => new URL(b.url).hostname === d || new URL(b.url).hostname.endsWith("." + d))) throw new HttpError(400, "domain_not_approved", "Only the assistant's approved domains can be crawled.");
  const r = await one<{ id: string }>(`INSERT INTO knowledge_sources (organization_id, assistant_id, type, name, url, collection, priority, config) VALUES ($1,$2,'website',$3,$4,$5,$6,$7) RETURNING id`,
    [a.organizationId, a.id, b.name, b.url, b.collection, b.priority, JSON.stringify({ url: b.url, sitemaps: b.sitemaps, include_prefixes: b.include_prefixes.length ? b.include_prefixes : [new URL(b.url).origin + "/"], max_pages: b.max_pages })]);
  await audit(s.org, s.uid, "knowledge.source_create", "knowledge_source", r!.id, { url: b.url });
  return json({ id: r!.id });
});
route("PATCH", "/knowledge/sources/:id", "admin", async (req, p, s) => {
  const b = await body(req, z.object({ status: z.enum(["active", "disabled"]) }));
  await getDb().query(`UPDATE knowledge_sources SET status = $3 WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org, b.status]);
  await getDb().query(`UPDATE knowledge_documents SET status = CASE WHEN $3 = 'disabled' THEN 'disabled' ELSE 'active' END WHERE source_id = $1 AND organization_id = $2 AND status IN ('active','disabled')`, [p.id, s.org, b.status]);
  await audit(s.org, s.uid, "knowledge.source_update", "knowledge_source", p.id, b);
  return json({ ok: true });
});
route("POST", "/knowledge/sources/:id/crawl", "editor", async (_req, p, s, url, ctx) => {
  const a = await assistantFor(s, url);
  const src = await one(`SELECT id FROM knowledge_sources WHERE id = $1 AND assistant_id = $2 AND type = 'website' AND status = 'active'`, [uuid.parse(p.id), a.id]);
  if (!src) throw new HttpError(404, "not_found");
  if (!ctx.triggerCrawl) throw new HttpError(501, "crawler_unavailable");
  await ctx.triggerCrawl(a, p.id);
  await audit(s.org, s.uid, "knowledge.crawl", "knowledge_source", p.id);
  return json({ started: true });
});
route("POST", "/knowledge/search-test", "viewer", async (req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const b = await body(req, z.object({ query: z.string().min(2).max(300), collection: z.enum(["sales", "support"]).default("sales") }));
  const r = await searchKnowledge(a.id, [b.query], { collection: b.collection, topK: 8, embedder: getEmbedder() });
  return json({ results: r.map((c) => ({ ...c, content: c.content.slice(0, 600) })) });
});
route("GET", "/knowledge/conflicts", "viewer", async (_req, _p, s, url) => json({ items: await many(`SELECT * FROM knowledge_conflicts WHERE assistant_id = $1 ORDER BY status, created_at DESC`, [(await assistantFor(s, url)).id]) }));
route("PATCH", "/knowledge/conflicts/:id", "editor", async (req, p, s) => {
  const b = await body(req, z.object({ status: z.enum(["open", "resolved", "dismissed"]), resolution: z.string().max(2000).optional() }));
  await getDb().query(`UPDATE knowledge_conflicts SET status = $3, resolution = coalesce($4, resolution), resolved_at = CASE WHEN $3 = 'open' THEN NULL ELSE now() END WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org, b.status, b.resolution ?? null]);
  await audit(s.org, s.uid, "knowledge.conflict_update", "knowledge_conflict", p.id, b);
  return json({ ok: true });
});
route("GET", "/knowledge/unanswered", "viewer", async (_req, _p, s, url) => json({ items: await many(`SELECT * FROM unanswered_questions WHERE assistant_id = $1 ORDER BY status, created_at DESC LIMIT 300`, [(await assistantFor(s, url)).id]) }));
route("PATCH", "/knowledge/unanswered/:id", "editor", async (req, p, s) => {
  const b = await body(req, z.object({ status: z.enum(["open", "answered", "dismissed"]) }));
  await getDb().query(`UPDATE unanswered_questions SET status = $3 WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org, b.status]);
  return json({ ok: true });
});
route("GET", "/knowledge/versions", "viewer", async (_req, _p, s, url) => json({ items: await many(`SELECT v.*, u.email AS created_by_email FROM knowledge_versions v LEFT JOIN admin_users u ON u.id = v.created_by WHERE v.assistant_id = $1 ORDER BY version DESC LIMIT 100`, [(await assistantFor(s, url)).id]) }));

// ------------------------------------------------------------------ services (recommendation engine)
const ServiceBody = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.object({ fr: z.string(), en: z.string() }), description: z.object({ fr: z.string(), en: z.string() }),
  categories: z.array(z.string()).max(10), problems: z.object({ fr: z.array(z.string()), en: z.array(z.string()) }), features: z.object({ fr: z.array(z.string()), en: z.array(z.string()) }),
  price_note: z.object({ fr: z.string(), en: z.string() }), next_step: z.enum(["demo", "callback", "quote", "support", "info"]), url: z.string().url().nullable().optional(), enabled: z.boolean(), sort: z.number().int(),
});
route("GET", "/services", "viewer", async (_req, _p, s, url) => json({ items: await many(`SELECT * FROM recommended_services WHERE assistant_id = $1 ORDER BY sort`, [(await assistantFor(s, url)).id]) }));
route("PUT", "/services", "editor", async (req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const b = await body(req, ServiceBody);
  await getDb().query(`INSERT INTO recommended_services (organization_id, assistant_id, key, name, description, categories, problems, features, price_note, next_step, url, enabled, sort)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (assistant_id, key) DO UPDATE SET name = $4, description = $5, categories = $6, problems = $7, features = $8, price_note = $9, next_step = $10, url = $11, enabled = $12, sort = $13, updated_at = now()`,
    [a.organizationId, a.id, b.key, JSON.stringify(b.name), JSON.stringify(b.description), b.categories, JSON.stringify(b.problems), JSON.stringify(b.features), JSON.stringify(b.price_note), b.next_step, b.url ?? null, b.enabled, b.sort]);
  await audit(s.org, s.uid, "service.upsert", "service", b.key);
  return json({ ok: true });
});
route("DELETE", "/services/:key", "admin", async (_req, p, s, url) => {
  const a = await assistantFor(s, url);
  await getDb().query(`DELETE FROM recommended_services WHERE assistant_id = $1 AND key = $2`, [a.id, p.key]);
  await audit(s.org, s.uid, "service.delete", "service", p.key);
  return json({ ok: true });
});

// ------------------------------------------------------------------ settings & domains & assistants
route("GET", "/assistants", "viewer", async (_req, _p, s) => json({ items: await many(`SELECT id, public_key, name, status, created_at FROM assistants WHERE organization_id = $1 ORDER BY created_at`, [s.org]) }));
route("POST", "/assistants", "owner", async (req, _p, s) => {
  const b = await body(req, z.object({ public_key: z.string().regex(/^[a-z0-9-]{3,40}$/), name: z.string().min(2).max(100), copy_from: z.string().uuid().optional() }));
  const a = await one<{ id: string }>(`INSERT INTO assistants (organization_id, public_key, name) VALUES ($1,$2,$3) RETURNING id`, [s.org, b.public_key, b.name]).catch(() => { throw new HttpError(409, "public_key_taken"); });
  const base = b.copy_from ? await one<{ settings: unknown }>(`SELECT settings FROM assistant_settings WHERE assistant_id = $1 AND organization_id = $2`, [b.copy_from, s.org]) : null;
  await getDb().query(`INSERT INTO assistant_settings (assistant_id, organization_id, settings) VALUES ($1,$2,$3)`, [a!.id, s.org, JSON.stringify({ ...((base?.settings as object) ?? {}), seedVersionApplied: 1 })]);
  await audit(s.org, s.uid, "assistant.create", "assistant", a!.id, b);
  return json({ id: a!.id });
});
route("GET", "/settings", "viewer", async (_req, _p, s, url) => {
  const a = await assistantFor(s, url);
  return json({ assistant: { id: a.id, public_key: a.publicKey, name: a.name, status: a.status }, settings: a.settings, domains: a.allowedDomains });
});
route("PUT", "/settings", "admin", async (req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const raw = await readJson(req, 400 * 1024) as { settings?: unknown };
  const parsed = SettingsSchema.safeParse(raw.settings);
  if (!parsed.success) throw new HttpError(400, "invalid_settings", parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (parsed.data.booking.url && !/^https:\/\//.test(parsed.data.booking.url)) throw new HttpError(400, "invalid_booking_url");
  for (const k of ["avatarUrl", "logoUrl"] as const) {
    const v = parsed.data.appearance[k];
    if (v && !(/^(https:\/\/|\/)/.test(v) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v))) throw new HttpError(400, "invalid_image", `${k} must be an https URL, a site path or an uploaded image`);
    if (v && v.length > 120_000) throw new HttpError(413, "image_too_large", "Image too large (max ~90 KB after resizing).");
  }
  const next = { ...parsed.data, seedVersionApplied: a.settings.seedVersionApplied };
  await getDb().query(`UPDATE assistant_settings SET settings = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE assistant_id = $1`, [a.id, JSON.stringify(next), s.uid]);
  invalidateAssistantCache();
  await audit(s.org, s.uid, "settings.update", "assistant", a.id);
  return json({ ok: true });
});
route("PUT", "/domains", "admin", async (req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const b = await body(req, z.object({ domains: z.array(z.string().regex(/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/i)).max(50) }));
  await getDb().query(`DELETE FROM assistant_allowed_domains WHERE assistant_id = $1`, [a.id]);
  for (const d of b.domains) await getDb().query(`INSERT INTO assistant_allowed_domains (organization_id, assistant_id, domain) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [a.organizationId, a.id, d.toLowerCase()]);
  invalidateAssistantCache();
  await audit(s.org, s.uid, "settings.domains", "assistant", a.id, { domains: b.domains });
  return json({ ok: true });
});

// ------------------------------------------------------------------ tickets
route("GET", "/tickets", "viewer", async (_req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const st = url.searchParams.get("status");
  return json({ items: await many(`SELECT * FROM support_tickets WHERE assistant_id = $1 ${st ? "AND status = $2" : ""} ORDER BY created_at DESC LIMIT 300`, st ? [a.id, st] : [a.id]) });
});
route("PATCH", "/tickets/:id", "editor", async (req, p, s) => {
  const b = await body(req, z.object({ status: z.enum(["open", "in_progress", "waiting", "resolved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), assigned_team: z.string().max(60).optional() }));
  await getDb().query(`UPDATE support_tickets SET status = coalesce($3, status), priority = coalesce($4, priority), assigned_team = coalesce($5, assigned_team), updated_at = now() WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org, b.status ?? null, b.priority ?? null, b.assigned_team ?? null]);
  await audit(s.org, s.uid, "ticket.update", "support_ticket", p.id, b);
  return json({ ok: true });
});

// ------------------------------------------------------------------ integrations
const IntegrationBody = z.object({
  type: z.enum(["webhook", "zapier", "make", "highlevel", "utilmo_crm", "email", "cal_com", "calendly"]), name: z.string().min(2).max(100), enabled: z.boolean().default(false),
  config: z.object({ url: z.string().url().optional(), events: z.array(z.enum(["lead.captured", "lead.qualified", "support.ticket_created", "human.requested"])).default([]), field_mapping: z.record(z.string(), z.string()).optional(), location_id: z.string().max(100).optional(), to: z.string().max(1000).optional(), from: z.string().max(200).optional(), provider: z.enum(["smtp", "resend"]).optional(), smtp_host: z.string().max(200).optional(), smtp_port: z.number().int().min(1).max(65535).optional(), smtp_user: z.string().max(200).optional() }).default({ events: [] }),
  secret: z.string().max(2000).optional(),
});
function maskIntegration(i: Record<string, unknown>) { const { secret_encrypted, ...rest } = i; return { ...rest, has_secret: !!secret_encrypted }; }
route("GET", "/integrations", "viewer", async (_req, _p, s) => json({ items: (await many<Record<string, unknown>>(`SELECT * FROM integrations WHERE organization_id = $1 ORDER BY created_at`, [s.org])).map(maskIntegration) }));
route("POST", "/integrations", "admin", async (req, _p, s, url) => {
  const a = await assistantFor(s, url);
  const b = await body(req, IntegrationBody);
  if (b.config.url && ["webhook", "zapier", "make"].includes(b.type)) await assertSafeDestination(b.config.url).catch((e) => { throw new HttpError(400, "unsafe_destination", (e as Error).message); });
  const r = await one<{ id: string }>(`INSERT INTO integrations (organization_id, assistant_id, type, name, enabled, config, secret_encrypted) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [s.org, a.id, b.type, b.name, b.enabled, JSON.stringify(b.config), b.secret ? encrypt(b.secret) : null]);
  await audit(s.org, s.uid, "integration.create", "integration", r!.id, { type: b.type, url_host: b.config.url ? new URL(b.config.url).host : null });
  return json({ id: r!.id });
});
route("PATCH", "/integrations/:id", "admin", async (req, p, s) => {
  const b = await body(req, IntegrationBody.partial());
  if (b.config?.url) await assertSafeDestination(b.config.url).catch((e) => { throw new HttpError(400, "unsafe_destination", (e as Error).message); });
  await getDb().query(`UPDATE integrations SET name = coalesce($3, name), enabled = coalesce($4, enabled), config = coalesce($5::jsonb, config), secret_encrypted = coalesce($6, secret_encrypted), updated_at = now() WHERE id = $1 AND organization_id = $2`,
    [uuid.parse(p.id), s.org, b.name ?? null, b.enabled ?? null, b.config ? JSON.stringify(b.config) : null, b.secret ? encrypt(b.secret) : null]);
  await audit(s.org, s.uid, "integration.update", "integration", p.id, { fields: Object.keys(b).filter((k) => k !== "secret"), secret_changed: !!b.secret });
  return json({ ok: true });
});
route("DELETE", "/integrations/:id", "admin", async (_req, p, s) => {
  await getDb().query(`DELETE FROM integrations WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org]);
  await audit(s.org, s.uid, "integration.delete", "integration", p.id);
  return json({ ok: true });
});
route("POST", "/integrations/:id/test", "admin", async (_req, p, s) => {
  const it = await one(`SELECT id FROM integrations WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org]);
  if (!it) throw new HttpError(404, "not_found");
  const r = await sendTestEvent(s.org, p.id);
  const d = await one(`SELECT status, last_status_code, last_error, response_excerpt FROM webhook_deliveries WHERE id = $1`, [r.deliveryId]);
  await audit(s.org, s.uid, "integration.test", "integration", p.id, { result: r.result });
  return json({ ...r, delivery: d });
});
route("GET", "/deliveries", "viewer", async (_req, _p, s, url) => {
  const st = url.searchParams.get("status");
  return json({ items: await many(`SELECT d.id, d.event, d.status, d.attempts, d.next_attempt_at, d.last_status_code, d.last_error, d.created_at, d.delivered_at, d.idempotency_key, i.name AS integration, i.type
    FROM webhook_deliveries d JOIN integrations i ON i.id = d.integration_id WHERE d.organization_id = $1 ${st ? "AND d.status = $2" : ""} ORDER BY d.created_at DESC LIMIT 200`, st ? [s.org, st] : [s.org]) });
});
route("POST", "/deliveries/:id/retry", "editor", async (_req, p, s) => {
  await getDb().query(`UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = now() WHERE id = $1 AND organization_id = $2 AND status IN ('failed','dead')`, [uuid.parse(p.id), s.org]);
  return json({ result: await attemptDelivery(p.id) });
});

// ------------------------------------------------------------------ users & audit
route("GET", "/users", "admin", async (_req, _p, s) => json({ items: await many(`SELECT id, email, name, role, active, last_login_at, created_at FROM admin_users WHERE organization_id = $1 ORDER BY created_at`, [s.org]) }));
route("POST", "/users", "admin", async (req, _p, s) => {
  const b = await body(req, z.object({ email: z.string().email(), name: z.string().max(100).optional(), role: z.enum(["admin", "editor", "viewer"]), password: z.string().optional() }));
  const { randomToken, sha256 } = await import("./crypto");
  // Without a password, the user receives an invitation e-mail to choose it (link valid 72 h).
  if (b.password) { const pwErr = validatePassword(b.password); if (pwErr) throw new HttpError(400, "weak_password", pwErr); }
  const r = await one<{ id: string }>(`INSERT INTO admin_users (organization_id, email, name, role, password_hash) VALUES ($1, lower($2), $3, $4, $5) RETURNING id`,
    [s.org, b.email, b.name ?? null, b.role, await hashPassword(b.password || randomToken(32))]).catch(() => { throw new HttpError(409, "email_taken"); });
  let invited = false;
  if (!b.password) {
    const token = randomToken(32);
    await getDb().query(`INSERT INTO password_resets (admin_user_id, token_hash, purpose, expires_at) VALUES ($1,$2,'invite', now() + interval '72 hours')`, [r!.id, sha256(token)]);
    const base = new URL(req.url).origin;
    const me = await one<{ name: string | null; email: string }>(`SELECT name, email FROM admin_users WHERE id = $1`, [s.uid]);
    const org = await one<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [s.org]);
    const { accountEmail, sendSystemEmail } = await import("./webhooks");
    invited = await sendSystemEmail(s.org, b.email.toLowerCase(), accountEmail(base, "invite", `${base}/admin/#/reset?token=${token}`, { inviter: me?.name || me?.email, org: org?.name }));
    if (!invited) { await getDb().query(`DELETE FROM admin_users WHERE id = $1`, [r!.id]); throw new HttpError(503, "email_not_configured", "L'envoi de courriels n'est pas configuré (Notifications). Configurez-le ou indiquez un mot de passe initial. / Email sending is not configured: set it up in Notifications or provide an initial password."); }
  }
  await audit(s.org, s.uid, "user.create", "admin_user", r!.id, { role: b.role, invited });
  return json({ id: r!.id, invited });
});
route("PATCH", "/users/:id", "admin", async (req, p, s) => {
  const b = await body(req, z.object({ role: z.enum(["admin", "editor", "viewer"]).optional(), active: z.boolean().optional(), password: z.string().optional() }));
  if (p.id === s.uid && (b.active === false || b.role)) throw new HttpError(400, "cannot_modify_self");
  const target = await one<{ role: string }>(`SELECT role FROM admin_users WHERE id = $1 AND organization_id = $2`, [uuid.parse(p.id), s.org]);
  if (!target) throw new HttpError(404, "not_found");
  if (target.role === "owner" && s.role !== "owner") throw new HttpError(403, "forbidden");
  if (b.password) { const e = validatePassword(b.password); if (e) throw new HttpError(400, "weak_password", e); }
  await getDb().query(`UPDATE admin_users SET role = coalesce($3, role), active = coalesce($4, active), password_hash = coalesce($5, password_hash) WHERE id = $1 AND organization_id = $2`,
    [p.id, s.org, b.role ?? null, b.active ?? null, b.password ? await hashPassword(b.password) : null]);
  await audit(s.org, s.uid, "user.update", "admin_user", p.id, { role: b.role, active: b.active, password_changed: !!b.password });
  return json({ ok: true });
});
route("GET", "/audit", "admin", async (_req, _p, s) => json({ items: await many(`SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.created_at, u.email FROM audit_logs a LEFT JOIN admin_users u ON u.id = a.admin_user_id WHERE a.organization_id = $1 ORDER BY a.created_at DESC LIMIT 300`, [s.org]) }));
route("GET", "/system", "viewer", async () => {
  const { env, hasSecret } = await import("./env");
  const { hasVector } = await import("./retrieval");
  return json({
    ai_provider: env("AI_PROVIDER") ?? "anthropic (default)", ai_gateway: !!(env("ANTHROPIC_BASE_URL") || env("NETLIFY_AI_GATEWAY_URL")), own_ai_key: !!env("AI_API_KEY"),
    embeddings: getEmbedder() ? "openai" : "not_configured (full-text retrieval only)", pgvector: await hasVector().catch(() => false),
    secrets: Object.fromEntries(["SESSION_SECRET", "ADMIN_AUTH_SECRET", "ENCRYPTION_KEY"].map((k) => [k, hasSecret(k) ? "environment variable" : "server-generated (database)"])),
    admin_setup_token: hasSecret("ADMIN_SETUP_TOKEN") ? "configured" : "not configured",
    database: env("DATABASE_URL") ? "DATABASE_URL" : "Netlify Database",
  });
});

// ------------------------------------------------------------------ public auth endpoints
async function handleAuth(req: Request, path: string, ctx: AdminCtx): Promise<Response | null> {
  const ip = ctx.ip ?? clientIp(req);
  if (path === "/setup-status" && req.method === "GET") {
    const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_users`);
    const { hasSecret, isDevMode } = await import("./env");
    return json({ needsSetup: (r?.n ?? 0) === 0, setupTokenConfigured: hasSecret("ADMIN_SETUP_TOKEN") || isDevMode() });
  }
  if (path === "/setup" && req.method === "POST") {
    if (!(await rateLimit(`setup:${ipHash(ip)}`, 5, 900))) throw new HttpError(429, "rate_limited");
    const b = await body(req, z.object({ token: z.string().min(1).max(500), email: z.string().email(), password: z.string(), name: z.string().max(100).optional(), organization: z.string().default("utilmo") }));
    const count = await one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_users`);
    if ((count?.n ?? 0) > 0) throw new HttpError(409, "already_initialized");
    const { hasSecret, isDevMode } = await import("./env");
    if (!hasSecret("ADMIN_SETUP_TOKEN") && !isDevMode()) throw new HttpError(503, "setup_token_not_configured", "Set ADMIN_SETUP_TOKEN (16+ characters) in Netlify environment variables, redeploy, then use it here.");
    if (!setupTokenMatches(b.token)) { await audit(null, null, "admin.setup_failed", null, null, {}, ip); throw new HttpError(403, "invalid_setup_token"); }
    const pwErr = validatePassword(b.password); if (pwErr) throw new HttpError(400, "weak_password", pwErr);
    const org = await one<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [b.organization]);
    if (!org) throw new HttpError(404, "organization_not_found");
    const u = await one<{ id: string }>(`INSERT INTO admin_users (organization_id, email, name, role, password_hash) VALUES ($1, lower($2), $3, 'owner', $4) RETURNING id`, [org.id, b.email, b.name ?? null, await hashPassword(b.password)]);
    await audit(org.id, u!.id, "admin.setup", "admin_user", u!.id, {}, ip);
    return json({ ok: true });
  }
  if (path === "/login" && req.method === "POST") {
    if (!(await rateLimit(`login:${ipHash(ip)}`, 10, 900))) throw new HttpError(429, "rate_limited", "Too many attempts. Try again later.");
    const b = await body(req, z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }));
    const { token, session } = await login(b.email, b.password, ip);
    return json({ ok: true, user: { email: session.email, role: session.role } }, { headers: { "set-cookie": sessionCookie(token, 12 * 3600) } });
  }
  if (path === "/logout" && req.method === "POST") return json({ ok: true }, { headers: { "set-cookie": sessionCookie("", 0) } });
  if (path === "/recover" && req.method === "POST") {
    // One-time account recovery: requires ADMIN_RECOVERY_TOKEN (set by the site owner in Netlify).
    // Each token value works once; creates or resets an OWNER account in the organization.
    if (!(await rateLimit(`recover:${ipHash(ip)}`, 5, 900))) throw new HttpError(429, "rate_limited");
    const b = await body(req, z.object({ token: z.string().min(1).max(500), email: z.string().email(), password: z.string(), name: z.string().max(100).optional(), organization: z.string().default("utilmo") }));
    const { env } = await import("./env");
    const { sha256, safeEqual: eq, hmac: h } = await import("./crypto");
    const expected = env("ADMIN_RECOVERY_TOKEN");
    if (!expected || expected.length < 16) throw new HttpError(503, "recovery_not_configured", "Set ADMIN_RECOVERY_TOKEN (16+ characters) in Netlify environment variables, redeploy, then use it here.");
    if (!eq(h("recover", b.token), h("recover", expected))) { await audit(null, null, "admin.recovery_failed", null, null, {}, ip); throw new HttpError(403, "invalid_recovery_token"); }
    const usedKey = "recovery_used:" + sha256(expected).slice(0, 32);
    const used = await one(`SELECT 1 FROM app_secrets WHERE name = $1`, [usedKey]);
    if (used) throw new HttpError(409, "recovery_token_used", "This recovery token was already used. Set a new ADMIN_RECOVERY_TOKEN value to recover again.");
    const pwErr = validatePassword(b.password); if (pwErr) throw new HttpError(400, "weak_password", pwErr);
    const org = await one<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [b.organization]);
    if (!org) throw new HttpError(404, "organization_not_found");
    const hash = await hashPassword(b.password);
    const u = await one<{ id: string }>(
      `INSERT INTO admin_users (organization_id, email, name, role, password_hash, active) VALUES ($1, lower($2), $3, 'owner', $4, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = $4, role = 'owner', active = true, failed_logins = 0, locked_until = NULL, organization_id = $1, name = coalesce($3, admin_users.name)
       RETURNING id`, [org.id, b.email, b.name ?? null, hash]);
    await getDb().query(`INSERT INTO app_secrets (name, value) VALUES ($1, 'used')`, [usedKey]);
    await audit(org.id, u!.id, "admin.recovery", "admin_user", u!.id, {}, ip);
    return json({ ok: true });
  }
  if (path === "/forgot" && req.method === "POST") {
    // Always answers OK (no account enumeration). Sends a single-use link valid 1 hour.
    if (!(await rateLimit(`forgot:${ipHash(ip)}`, 5, 900))) throw new HttpError(429, "rate_limited");
    const b = await body(req, z.object({ email: z.string().email().max(254) }));
    const u = await one<{ id: string; organization_id: string; active: boolean }>(`SELECT id, organization_id, active FROM admin_users WHERE email = lower($1)`, [b.email]);
    if (u?.active) {
      const { randomToken, sha256 } = await import("./crypto");
      const token = randomToken(32);
      await getDb().query(`INSERT INTO password_resets (admin_user_id, token_hash, purpose, expires_at) VALUES ($1,$2,'reset', now() + interval '1 hour')`, [u.id, sha256(token)]);
      const base = new URL(req.url).origin;
      const { accountEmail, sendSystemEmail } = await import("./webhooks");
      const sent = await sendSystemEmail(u.organization_id, b.email.toLowerCase(), accountEmail(base, "reset", `${base}/admin/#/reset?token=${token}`));
      await audit(u.organization_id, u.id, "admin.password_reset_requested", "admin_user", u.id, { email_sent: sent }, ip);
    }
    return json({ ok: true });
  }
  if (path === "/reset" && req.method === "POST") {
    if (!(await rateLimit(`reset:${ipHash(ip)}`, 10, 900))) throw new HttpError(429, "rate_limited");
    const b = await body(req, z.object({ token: z.string().min(20).max(200), password: z.string().max(200) }));
    const { sha256 } = await import("./crypto");
    const r = await one<{ id: string; admin_user_id: string; purpose: string }>(`SELECT id, admin_user_id, purpose FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [sha256(b.token)]);
    if (!r) throw new HttpError(400, "invalid_or_expired_link", "Ce lien est invalide ou expiré. / This link is invalid or expired.");
    const e = validatePassword(b.password); if (e) throw new HttpError(400, "weak_password", e);
    await getDb().query(`UPDATE admin_users SET password_hash = $2, active = true, failed_logins = 0, locked_until = NULL WHERE id = $1`, [r.admin_user_id, await hashPassword(b.password)]);
    await getDb().query(`UPDATE password_resets SET used_at = now() WHERE admin_user_id = $1 AND used_at IS NULL`, [r.admin_user_id]);
    const u = await one<{ organization_id: string; email: string }>(`SELECT organization_id, email FROM admin_users WHERE id = $1`, [r.admin_user_id]);
    await audit(u!.organization_id, r.admin_user_id, r.purpose === "invite" ? "admin.invite_accepted" : "admin.password_reset", "admin_user", r.admin_user_id, {}, ip);
    return json({ ok: true, email: u!.email });
  }
  if (path === "/me/password" && req.method === "POST") {
    const s = await requireAdmin(req);
    const b = await body(req, z.object({ current: z.string().min(1).max(200), password: z.string().max(200) }));
    const u = await one<{ password_hash: string }>(`SELECT password_hash FROM admin_users WHERE id = $1`, [s.uid]);
    const { verifyPassword } = await import("./crypto");
    if (!u || !(await verifyPassword(b.current, u.password_hash))) throw new HttpError(400, "invalid_current_password", "Current password is incorrect.");
    const e = validatePassword(b.password); if (e) throw new HttpError(400, "weak_password", e);
    await getDb().query(`UPDATE admin_users SET password_hash = $2 WHERE id = $1`, [s.uid, await hashPassword(b.password)]);
    await audit(s.org, s.uid, "admin.password_changed", "admin_user", s.uid, {}, ip);
    return json({ ok: true });
  }
  if (path === "/me" && req.method === "GET") {
    const s = await requireAdmin(req);
    const org = await one<{ name: string; slug: string }>(`SELECT name, slug FROM organizations WHERE id = $1`, [s.org]);
    const u = await one<{ name: string | null; avatar: string | null; ui_language: string }>(`SELECT name, avatar, ui_language FROM admin_users WHERE id = $1`, [s.uid]);
    return json({ user: { id: s.uid, email: s.email, role: s.role, name: u?.name ?? null, avatar: u?.avatar ?? null, ui_language: u?.ui_language ?? "fr" }, organization: org });
  }
  if (path === "/me" && req.method === "PATCH") {
    const s = await requireAdmin(req);
    const b = await body(req, z.object({
      name: z.string().max(100).optional(),
      avatar: z.string().max(200_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).nullable().optional(),
      ui_language: z.enum(["fr", "en"]).optional(),
    }), 256 * 1024);
    await getDb().query(`UPDATE admin_users SET name = coalesce($2, name), avatar = CASE WHEN $3::boolean THEN $4 ELSE avatar END, ui_language = coalesce($5, ui_language) WHERE id = $1`,
      [s.uid, b.name ?? null, b.avatar !== undefined, b.avatar ?? null, b.ui_language ?? null]);
    await audit(s.org, s.uid, "admin.profile_updated", "admin_user", s.uid, { fields: Object.keys(b) }, ip);
    return json({ ok: true });
  }
  return null;
}

/** Entry point for /api/admin/* */
export async function handleAdmin(req: Request, ctx: AdminCtx = {}): Promise<Response> {
  try {
    const { ensureSecrets } = await import("./env");
    await ensureSecrets();
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/admin/, "") || "/";
    const pub = await handleAuth(req, path, ctx);
    if (pub) return pub;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.pattern);
      if (!m) continue;
      const s = await requireAdmin(req, r.role);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return await r.h(req, params, s, url, ctx);
    }
    throw new HttpError(404, "not_found");
  } catch (e) {
    if (e instanceof z.ZodError) return json({ error: "invalid_id" }, { status: 400 });
    return errorResponse(e);
  }
}
