import { ChatRequestSchema, ClientEventSchema, type ChatStreamEvent, type StoredMessage } from "../packages/shared/src/protocol";
import { publicSettings } from "../packages/shared/src/settings";
import { runTurn } from "../packages/ai-core/src/orchestrator";
import { effectiveSettings, getEmbedder, getLLM } from "./ai";
import { SqlChatStore, toRecord, type ConversationRow } from "./chat-store";
import { ipHash, randomToken } from "./crypto";
import { getDb, many, one } from "./db";
import { clientIp, corsHeaders, errorResponse, HttpError, json, readJson } from "./http";
import { bootstrapAssistant } from "./knowledge";
import { checkOrigin } from "./origin";
import { rateLimit } from "./ratelimit";
import { searchKnowledge } from "./retrieval";
import { signSession, verifySession } from "./session";
import { loadAssistant, loadServices, type AssistantCtx } from "./tenant";
import { enqueueEvent } from "./webhooks";

export interface Ctx { ip?: string; waitUntil?: (p: Promise<unknown>) => void; triggerCrawl?: (assistant: AssistantCtx, sourceId: string) => Promise<void> }

async function resolveAssistant(req: Request, publicKey: string | null) {
  if (!publicKey || !/^[a-z0-9_-]{1,64}$/i.test(publicKey)) throw new HttpError(400, "invalid_assistant");
  const a = await loadAssistant(publicKey);
  if (!a || a.status !== "active") throw new HttpError(404, "assistant_not_found");
  const o = checkOrigin(req, a.allowedDomains);
  if (!o.ok) throw new HttpError(403, "origin_not_allowed", "This website is not authorised to use this assistant.");
  return { a, cors: corsHeaders(o.origin) };
}

export function preflight(req: Request): Response {
  const origin = req.headers.get("origin");
  // Preflight carries no assistant id; the real request is validated against the assistant's allowed domains.
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/** GET /api/widget-config?assistantId=… — public, non-secret configuration. */
export async function handleConfig(req: Request): Promise<Response> {
  let cors: Record<string, string> = {};
  try {
    const url = new URL(req.url);
    const r = await resolveAssistant(req, url.searchParams.get("assistantId"));
    cors = r.cors;
    const s = r.a.settings;
    const hosts = new Set<string>([...r.a.allowedDomains.filter((d) => !d.startsWith("*"))]);
    for (const u of [s.booking.url, s.privacy.privacyPolicyUrl.fr, s.privacy.privacyPolicyUrl.en]) { try { if (u) hosts.add(new URL(u).hostname); } catch { /* */ } }
    const kb = await many<{ url: string }>(`SELECT DISTINCT url FROM knowledge_documents WHERE assistant_id = $1 AND status = 'active' AND url IS NOT NULL LIMIT 500`, [r.a.id]);
    for (const k of kb) { try { hosts.add(new URL(k.url).hostname); } catch { /* */ } }
    return json({ assistantId: r.a.publicKey, settings: publicSettings(s), approvedLinkHosts: [...hosts], version: 1 }, { headers: { ...cors, "cache-control": "public, max-age=60" } });
  } catch (e) { return errorResponse(e, cors); }
}

async function getOrCreateConversation(a: AssistantCtx, token: string | null | undefined, firstTouch: Record<string, unknown> | undefined, language: "fr" | "en") {
  const claims = verifySession(token, a.publicKey, a.settings.privacy.sessionRetentionDays);
  if (claims) {
    const row = await one<ConversationRow>(`SELECT * FROM conversations WHERE id = $1 AND visitor_id = $2 AND assistant_id = $3 AND status <> 'deleted'`, [claims.c, claims.v, a.id]);
    if (row && row.status !== "completed") return { row, token: token!, created: false };
    if (row) {
      // Completed conversations: continue in a fresh conversation for the same visitor.
      const conv = await one<ConversationRow>(`INSERT INTO conversations (organization_id, assistant_id, visitor_id, language, first_touch) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [a.organizationId, a.id, claims.v, language, JSON.stringify({})]);
      return { row: conv!, token: signSession({ a: a.publicKey, v: claims.v, c: conv!.id, iat: Date.now() }), created: true };
    }
  }
  const visitor = await one<{ id: string }>(`INSERT INTO visitors (organization_id, assistant_id, first_touch, language) VALUES ($1,$2,$3,$4) RETURNING id`, [a.organizationId, a.id, JSON.stringify(firstTouch ?? {}), language]);
  const conv = await one<ConversationRow>(`INSERT INTO conversations (organization_id, assistant_id, visitor_id, language, first_touch) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [a.organizationId, a.id, visitor!.id, language, JSON.stringify(firstTouch ?? {})]);
  return { row: conv!, token: signSession({ a: a.publicKey, v: visitor!.id, c: conv!.id, iat: Date.now() }), created: true };
}

/** POST /api/chat — streams NDJSON events. */
export async function handleChat(req: Request, ctx: Ctx = {}): Promise<Response> {
  let cors: Record<string, string> = {};
  try {
    const body = ChatRequestSchema.safeParse(await readJson(req, 32 * 1024));
    if (!body.success) throw new HttpError(400, "invalid_request", body.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ").slice(0, 300));
    const input = body.data;
    const r = await resolveAssistant(req, input.assistantId);
    cors = r.cors;
    const a = r.a;
    const settings = effectiveSettings(a.settings);
    if (input.message.length > settings.limits.maxMessageChars) throw new HttpError(413, "message_too_long");

    const ipKey = ipHash(clientIp(req, ctx));
    if (!(await rateLimit(`ip:${a.id}:${ipKey}`, settings.limits.messagesPerMinute * 3, 60))) throw new HttpError(429, "rate_limited", "Too many messages. Please wait a moment.");
    const daily = await one<{ requests: number }>(`SELECT requests FROM usage_daily WHERE assistant_id = $1 AND day = current_date`, [a.id]);
    if ((daily?.requests ?? 0) >= settings.limits.dailyMessageCap) throw new HttpError(503, "daily_cap_reached", "The assistant is temporarily unavailable.");

    // First-run knowledge bootstrap (idempotent; no-op once applied).
    if (a.settings.seedVersionApplied < 1) await bootstrapAssistant(a, ctx.triggerCrawl ? (sid) => ctx.triggerCrawl!(a, sid) : undefined);

    const lang = input.language ?? settings.behavior.defaultLanguage;
    const { row, token, created } = await getOrCreateConversation(a, input.sessionToken, input.firstTouch, lang);
    if (!(await rateLimit(`visitor:${row.visitor_id}`, settings.limits.messagesPerMinute, 60))) throw new HttpError(429, "rate_limited", "Too many messages. Please wait a moment.");
    if (row.message_count >= settings.limits.messagesPerConversation * 2) throw new HttpError(429, "conversation_limit", "This conversation is very long. Please start a new one or contact the team.");

    // Idempotency: a retried clientMessageId returns the stored reply instead of generating twice.
    const prior = await one<{ id: string; created_at: string }>(`SELECT id, created_at FROM messages WHERE conversation_id = $1 AND client_message_id = $2`, [row.id, input.clientMessageId]);
    if (prior) {
      const reply = await one<{ id: string; content: string; metadata: { actions?: unknown[]; state?: string; language?: string } }>(
        `SELECT id, content, metadata FROM messages WHERE conversation_id = $1 AND role = 'assistant' AND created_at > $2 ORDER BY created_at ASC LIMIT 1`, [row.id, prior.created_at]);
      if (reply) {
        const events: ChatStreamEvent[] = [
          { type: "session", sessionToken: token, conversationId: row.id },
          { type: "delta", text: reply.content },
          ...(reply.metadata.actions?.length ? [{ type: "actions", actions: reply.metadata.actions } as ChatStreamEvent] : []),
          { type: "done", messageId: reply.id, state: reply.metadata.state ?? row.state, language: (reply.metadata.language as "fr" | "en") ?? "fr" },
        ];
        return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: { ...cors, "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
      }
    }

    // Per-conversation lock: prevents duplicate simultaneous replies (e.g. inline + floating, two tabs).
    const locked = await one<{ id: string }>(`UPDATE conversations SET processing_until = now() + interval '75 seconds' WHERE id = $1 AND (processing_until IS NULL OR processing_until < now()) RETURNING id`, [row.id]);
    if (!locked) throw new HttpError(409, "busy", "A reply is already being generated for this conversation.");

    const store = new SqlChatStore(a.organizationId, a.id, row.visitor_id);
    const services = await loadServices(a.id);
    const embedder = getEmbedder();
    const background = (p: Promise<unknown>) => { const safe = p.catch((e) => console.warn("[bg]", String(e))); if (ctx.waitUntil) ctx.waitUntil(safe); };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (e: ChatStreamEvent) => { try { controller.enqueue(encoder.encode(JSON.stringify(e) + "\n")); } catch { /* client gone */ } };
        emit({ type: "session", sessionToken: token, conversationId: row.id });
        try {
          const llm = getLLM(settings);
          await runTurn({
            settings, llm, store, services, background,
            search: (queries, o) => searchKnowledge(a.id, queries, { ...o, embedder }),
            emitWebhook: (event, payload, key) => enqueueEvent(a.organizationId, a.id, event, payload, key).then(() => undefined),
            log: (m, extra) => console.warn(`[chat] ${m}`, JSON.stringify(extra ?? {})),
          }, { conversation: toRecord(row), message: input.message, clientMessageId: input.clientMessageId, languageHint: input.language, userMessageAlreadyStored: !!prior }, emit);
        } catch (err) {
          const code = (err as Error).message === "generation_failed" ? "generation_failed" : "internal_error";
          console.error("[chat] turn failed", err instanceof Error ? err.stack : err, (err as { cause?: unknown }).cause);
          emit({ type: "error", code, message: "The assistant could not answer. Please retry.", retryable: true });
        } finally {
          await getDb().query(`UPDATE conversations SET processing_until = NULL WHERE id = $1`, [row.id]).catch(() => {});
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { ...cors, "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  } catch (e) { return errorResponse(e, cors); }
}

/** GET /api/session?assistantId=&token= — restore a conversation (server is the source of truth). */
export async function handleSessionGet(req: Request): Promise<Response> {
  let cors: Record<string, string> = {};
  try {
    const url = new URL(req.url);
    const r = await resolveAssistant(req, url.searchParams.get("assistantId"));
    cors = r.cors;
    const claims = verifySession(url.searchParams.get("token"), r.a.publicKey, r.a.settings.privacy.sessionRetentionDays);
    if (!claims) return json({ conversation: null }, { headers: cors });
    const conv = await one<ConversationRow & { processing_until: string | null }>(`SELECT * FROM conversations WHERE id = $1 AND visitor_id = $2 AND assistant_id = $3 AND status <> 'deleted'`, [claims.c, claims.v, r.a.id]);
    if (!conv) return json({ conversation: null }, { headers: cors });
    const msgs = await many<{ id: string; role: "user" | "assistant"; content: string; metadata: { actions?: unknown[] }; created_at: string; client_message_id: string | null }>(
      `SELECT id, role, content, metadata, created_at, client_message_id FROM messages WHERE conversation_id = $1 AND role IN ('user','assistant') ORDER BY created_at ASC LIMIT 200`, [conv.id]);
    const messages: StoredMessage[] = msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, actions: m.role === "assistant" ? (m.metadata.actions as StoredMessage["actions"]) : undefined, createdAt: m.created_at, clientMessageId: m.client_message_id ?? undefined }));
    return json({ conversation: { id: conv.id, state: conv.state, language: conv.language, status: conv.status, busy: !!conv.processing_until && new Date(conv.processing_until) > new Date() }, messages }, { headers: cors });
  } catch (e) { return errorResponse(e, cors); }
}

/** DELETE /api/session — visitor-initiated deletion of their conversation (privacy). */
export async function handleSessionDelete(req: Request): Promise<Response> {
  let cors: Record<string, string> = {};
  try {
    const body = (await readJson(req)) as { assistantId?: string; sessionToken?: string };
    const r = await resolveAssistant(req, body.assistantId ?? null);
    cors = r.cors;
    const claims = verifySession(body.sessionToken, r.a.publicKey, 3650);
    if (!claims) return json({ ok: true }, { headers: cors });
    await getDb().query(`DELETE FROM messages WHERE conversation_id = $1 AND organization_id = $2`, [claims.c, r.a.organizationId]);
    await getDb().query(`UPDATE conversations SET status = 'deleted', profile = '{}'::jsonb, summary = NULL WHERE id = $1 AND visitor_id = $2`, [claims.c, claims.v]);
    await getDb().query(`INSERT INTO audit_logs (organization_id, action, target_type, target_id, details) VALUES ($1, 'visitor.conversation_deleted', 'conversation', $2, '{}'::jsonb)`, [r.a.organizationId, claims.c]);
    return json({ ok: true }, { headers: cors });
  } catch (e) { return errorResponse(e, cors); }
}

/** POST /api/event — limited client-side analytics (chat_opened, booking_clicked). */
export async function handleEvent(req: Request, ctx: Ctx = {}): Promise<Response> {
  let cors: Record<string, string> = {};
  try {
    const body = ClientEventSchema.safeParse(await readJson(req, 8 * 1024));
    if (!body.success) throw new HttpError(400, "invalid_event");
    const r = await resolveAssistant(req, body.data.assistantId);
    cors = r.cors;
    if (!(await rateLimit(`evt:${r.a.id}:${ipHash(clientIp(req, ctx))}`, 60, 60))) throw new HttpError(429, "rate_limited");
    const claims = verifySession(body.data.sessionToken, r.a.publicKey, r.a.settings.privacy.sessionRetentionDays);
    await getDb().query(`INSERT INTO analytics_events (organization_id, assistant_id, conversation_id, visitor_id, event, properties) VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.a.organizationId, r.a.id, claims?.c ?? null, claims?.v ?? null, body.data.event, JSON.stringify(body.data.properties ?? {})]);
    if (body.data.event === "booking_clicked" && claims) {
      const conv = await one<{ lead_id: string | null }>(`SELECT lead_id FROM conversations WHERE id = $1`, [claims.c]);
      await getDb().query(`INSERT INTO bookings (organization_id, assistant_id, conversation_id, lead_id, provider, status, payload) VALUES ($1,$2,$3,$4,$5,'clicked',$6)`,
        [r.a.organizationId, r.a.id, claims.c, conv?.lead_id ?? null, r.a.settings.booking.provider, JSON.stringify({ url: r.a.settings.booking.url, ref: randomToken(6) })]);
    }
    return json({ ok: true }, { headers: cors });
  } catch (e) { return errorResponse(e, cors); }
}
