import type { ChatStore, ConversationRecord, LeadUpsert } from "../packages/ai-core/src/orchestrator";
import { val, type Profile } from "../packages/ai-core/src/profile";
import { estimateCostUsd, type LLMUsage } from "../packages/ai-core/src/providers/types";
import type { ScoreResult } from "../packages/ai-core/src/scoring";
import { getDb, many, one } from "./db";

export interface ConversationRow {
  id: string; organization_id: string; assistant_id: string; visitor_id: string; lead_id: string | null;
  state: string; language: string; intents: string[]; profile: Profile; summary: string | null; status: string;
  escalation_status: string; message_count: number; unresolved_count: number; score: number;
}

export function toRecord(r: ConversationRow): ConversationRecord {
  return {
    id: r.id, visitorId: r.visitor_id, leadId: r.lead_id, state: r.state as ConversationRecord["state"], language: (r.language === "en" ? "en" : "fr"),
    profile: r.profile ?? {}, summary: r.summary, messageCount: r.message_count, unresolvedCount: r.unresolved_count,
    intents: r.intents ?? [], escalationStatus: r.escalation_status, score: r.score,
  };
}

/** SQL implementation of the orchestrator's persistence port. Every query is scoped by organization. */
export class SqlChatStore implements ChatStore {
  constructor(private orgId: string, private assistantId: string, private visitorId: string) {}

  async recentMessages(conversationId: string, limit: number) {
    const rows = await many<{ role: "user" | "assistant" | "agent"; content: string }>(
      `SELECT role, content FROM (SELECT role, content, created_at FROM messages WHERE conversation_id = $1 AND organization_id = $2 AND role IN ('user','assistant','agent') ORDER BY created_at DESC LIMIT $3) t ORDER BY created_at ASC`,
      [conversationId, this.orgId, limit]);
    // Team-member replies are shown to the model as assistant turns (marked) so the AI keeps context after a takeover.
    return rows.map((r) => (r.role === "agent" ? { role: "assistant" as const, content: `[Réponse d'un membre de l'équipe] ${r.content}` } : { role: r.role as "user" | "assistant", content: r.content }));
  }

  async addMessage(conversationId: string, role: "user" | "assistant", content: string, metadata: Record<string, unknown>, clientMessageId?: string) {
    const r = await one<{ id: string }>(
      `INSERT INTO messages (organization_id, conversation_id, role, content, metadata, client_message_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [this.orgId, conversationId, role, content, JSON.stringify(metadata), role === "user" ? clientMessageId ?? null : null]);
    return r!.id;
  }

  async updateConversation(id: string, p: Partial<ConversationRecord> & { previousState?: string; incrementMessages?: number; lastMessageAt?: Date }) {
    const sets: string[] = []; const vals: unknown[] = [id, this.orgId];
    const add = (col: string, v: unknown, cast = "") => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
    if (p.state) add("state", p.state);
    if (p.previousState) add("previous_state", p.previousState);
    if (p.language) add("language", p.language);
    if (p.profile) add("profile", JSON.stringify(p.profile), "::jsonb");
    if (p.leadId !== undefined) add("lead_id", p.leadId);
    if (p.intents) add("intents", p.intents);
    if (p.score !== undefined) add("score", p.score);
    if (p.escalationStatus) add("escalation_status", p.escalationStatus);
    if (p.summary !== undefined) add("summary", p.summary);
    if (p.unresolvedCount !== undefined) add("unresolved_count", p.unresolvedCount);
    if (p.lastMessageAt) add("last_message_at", p.lastMessageAt.toISOString());
    if (p.incrementMessages) { vals.push(p.incrementMessages); sets.push(`message_count = message_count + $${vals.length}`); }
    if (p.state === "COMPLETED") sets.push(`status = 'completed'`);
    if (p.state === "HUMAN_HANDOFF") sets.push(`status = 'handoff'`);
    if (!sets.length) return;
    sets.push("updated_at = now()");
    await getDb().query(`UPDATE conversations SET ${sets.join(", ")} WHERE id = $1 AND organization_id = $2`, vals);
  }

  async upsertLead(conv: ConversationRecord, lead: LeadUpsert) {
    const p = lead.profile;
    const email = val(p, "email") ?? null;
    const phone = val(p, "phone") ?? null;
    // Deduplicate on verified identifiers (normalised e-mail / E.164 phone) or the conversation's lead.
    const existing = await one<{ id: string; status: string; score: number }>(
      `SELECT id, status, score FROM leads WHERE organization_id = $1 AND (id = $2 OR ($3::text IS NOT NULL AND email_normalized = $3) OR ($4::text IS NOT NULL AND phone_e164 = $4))
       ORDER BY (id = $2) DESC, created_at ASC LIMIT 1`, [this.orgId, conv.leadId, email, phone]);
    const q = {
      main_goal: val(p, "main_goal"), current_crm: val(p, "current_crm"), website_status: val(p, "website_status"), lead_methods: val(p, "lead_methods"),
      biggest_challenge: val(p, "biggest_challenge"), lead_volume: val(p, "lead_volume"), automation_needs: val(p, "automation_needs"),
      timeline: val(p, "timeline"), budget_range: val(p, "budget_range"), demo_interest: val(p, "demo_interest"), support_issue: val(p, "support_issue"),
      score_reasons: lead.score.reasons,
    };
    const fields = [
      val(p, "first_name") ?? null, val(p, "last_name") ?? null, email, email, phone, phone, lead.language,
      val(p, "brokerage") ?? null, val(p, "city") ?? null, val(p, "territory") ?? [], val(p, "user_type") ?? null,
      val(p, "existing_customer") ?? "unknown", val(p, "services_interest") ?? [], JSON.stringify(q), lead.score.score, lead.score.priority,
    ];
    if (existing) {
      // Never downgrade a qualified lead; never overwrite non-null stored values with nulls.
      const status = existing.status === "qualified" && lead.status === "contact_captured" ? "qualified" : (existing.status === "new" ? lead.status : (lead.status === "qualified" ? "qualified" : existing.status));
      await getDb().query(
        `UPDATE leads SET first_name = coalesce($3, first_name), last_name = coalesce($4, last_name), email = coalesce($5, email), email_normalized = coalesce($6, email_normalized),
           phone_raw = coalesce($7, phone_raw), phone_e164 = coalesce($8, phone_e164), language = $9, brokerage = coalesce($10, brokerage), city = coalesce($11, city),
           territory = (SELECT array(SELECT DISTINCT unnest(territory || $12::text[]))), user_type = coalesce($13, user_type),
           existing_customer = CASE WHEN $14 = 'unknown' THEN existing_customer ELSE $14 END,
           services_interest = (SELECT array(SELECT DISTINCT unnest(services_interest || $15::text[]))),
           qualification = qualification || jsonb_strip_nulls($16::jsonb), score = $17, priority = $18, status = $19,
           consent = consent || $20::jsonb, summary = coalesce($21, summary), visitor_id = coalesce(visitor_id, $22), updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [existing.id, this.orgId, ...fields, status, JSON.stringify(lead.consent), lead.summary, this.visitorId]);
      return { leadId: existing.id, created: false, previousStatus: existing.status, previousScore: existing.score };
    }
    const r = await one<{ id: string }>(
      `INSERT INTO leads (organization_id, assistant_id, first_name, last_name, email, email_normalized, phone_raw, phone_e164, language, brokerage, city, territory,
         user_type, existing_customer, services_interest, qualification, score, priority, status, consent, summary, visitor_id, sync_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20::jsonb,$21,$22,
         CASE WHEN EXISTS (SELECT 1 FROM integrations WHERE organization_id = $1 AND enabled) THEN 'pending' ELSE 'not_configured' END)
       RETURNING id`,
      [this.orgId, this.assistantId, ...fields, lead.status, JSON.stringify(lead.consent), lead.summary, this.visitorId]);
    return { leadId: r!.id, created: true, previousStatus: null, previousScore: null };
  }

  async recordScore(leadId: string, conversationId: string, s: ScoreResult) {
    await getDb().query(`INSERT INTO lead_scores (organization_id, lead_id, conversation_id, score, priority, breakdown, reasons, scoring_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [this.orgId, leadId, conversationId, s.score, s.priority, JSON.stringify(s.breakdown), JSON.stringify(s.reasons), s.version]);
  }

  async createTicket(conv: ConversationRecord, t: { category: string; description: string; priority: string; history: { role: string; content: string }[]; summary: string | null; leadId: string | null }) {
    const p = conv.profile;
    const name = [val(p, "first_name"), val(p, "last_name")].filter(Boolean).join(" ") || null;
    const r = await one<{ id: string }>(
      `INSERT INTO support_tickets (organization_id, assistant_id, conversation_id, lead_id, customer_name, email, phone, category, description, history_excerpt, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id`,
      [this.orgId, this.assistantId, conv.id, t.leadId, name, val(p, "email") ?? null, val(p, "phone") ?? null, t.category, (t.summary ? `${t.description}\n\nRésumé: ${t.summary}` : t.description), JSON.stringify(t.history), t.priority]);
    return r!.id;
  }

  async recordRecommendations(conversationId: string, recs: { key: string; confidence: string; why: string }[]) {
    const newly: string[] = [];
    for (const r of recs) {
      const row = await one<{ service_key: string }>(
        `INSERT INTO conversation_recommendations (organization_id, conversation_id, service_key, confidence, reason) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (conversation_id, service_key) DO NOTHING RETURNING service_key`,
        [this.orgId, conversationId, r.key, r.confidence === "high" ? 0.9 : r.confidence === "medium" ? 0.6 : 0.3, r.why.slice(0, 300)]);
      if (row) newly.push(row.service_key);
    }
    return newly;
  }

  async openConflicts() {
    return many<{ topic: string; description: string }>(`SELECT topic, description FROM knowledge_conflicts WHERE assistant_id = $1 AND status = 'open' ORDER BY created_at LIMIT 10`, [this.assistantId]);
  }

  async track(event: string, props: Record<string, unknown>, conversationId?: string) {
    try {
      await getDb().query(`INSERT INTO analytics_events (organization_id, assistant_id, conversation_id, visitor_id, event, properties) VALUES ($1,$2,$3,$4,$5,$6)`,
        [this.orgId, this.assistantId, conversationId ?? null, this.visitorId, event, JSON.stringify(props)]);
    } catch (e) { console.warn("[analytics] failed", String(e).slice(0, 200)); }
  }

  async recordUsage(model: string, u: LLMUsage, latencyMs: number) {
    try {
      await getDb().query(
        `INSERT INTO usage_daily (organization_id, assistant_id, day, requests, input_tokens, output_tokens, est_cost_usd, total_latency_ms)
         VALUES ($1,$2,current_date,$3,$4,$5,$6,$7)
         ON CONFLICT (assistant_id, day) DO UPDATE SET requests = usage_daily.requests + $3, input_tokens = usage_daily.input_tokens + $4,
           output_tokens = usage_daily.output_tokens + $5, est_cost_usd = usage_daily.est_cost_usd + $6, total_latency_ms = usage_daily.total_latency_ms + $7`,
        [this.orgId, this.assistantId, latencyMs ? 1 : 0, u.inputTokens, u.outputTokens, estimateCostUsd(model, u), latencyMs]);
    } catch (e) { console.warn("[usage] failed", String(e).slice(0, 200)); }
  }

  async addUnanswered(conversationId: string, question: string, language: string, reason: string) {
    await getDb().query(`INSERT INTO unanswered_questions (organization_id, assistant_id, conversation_id, question, language, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
      [this.orgId, this.assistantId, conversationId, question, language, reason]);
  }

  async addConflict(conversationId: string, description: string) {
    const dup = await one(`SELECT 1 FROM knowledge_conflicts WHERE assistant_id = $1 AND status = 'open' AND description = $2`, [this.assistantId, description]);
    if (dup) return;
    await getDb().query(`INSERT INTO knowledge_conflicts (organization_id, assistant_id, topic, description, detected_by, conversation_id) VALUES ($1,$2,$3,$4,'assistant',$5)`,
      [this.orgId, this.assistantId, "Détecté en conversation / detected in conversation", description, conversationId]);
  }
}
