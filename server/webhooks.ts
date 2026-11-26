import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { decrypt, hmac, randomToken } from "./crypto";
import { getDb, many, one } from "./db";
import { isDevMode } from "./env";

export const PAYLOAD_SCHEMA_VERSION = "2026-11-23";
const BACKOFF_MIN = [1, 5, 30, 120, 720]; // minutes between attempts
const MAX_ATTEMPTS = 6;

export type WebhookEvent = "lead.captured" | "lead.qualified" | "support.ticket_created" | "human.requested" | "test.ping";

interface Integration { id: string; organization_id: string; type: string; name: string; enabled: boolean; config: { url?: string; events?: string[]; field_mapping?: Record<string, string>; location_id?: string; to?: string; from?: string; provider?: "smtp" | "resend"; smtp_host?: string; smtp_port?: number; smtp_user?: string }; secret_encrypted: string | null }

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:192.168.") || l === "::";
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** SSRF protection: only HTTPS to public hosts (admin-configured destinations only). */
export async function assertSafeDestination(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Invalid URL"); }
  if (u.protocol !== "https:" && !(isDevMode() && u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error("Only https:// destinations are allowed");
  if (isDevMode() && ["localhost", "127.0.0.1"].includes(u.hostname)) return u;
  if (u.username || u.password) throw new Error("Credentials in URL are not allowed");
  if (["localhost"].includes(u.hostname) || u.hostname.endsWith(".internal") || u.hostname.endsWith(".local")) throw new Error("Private destination not allowed");
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
  if (addrs.some((x) => isPrivateIp(x.address))) throw new Error("Private destination not allowed");
  return u;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Build the versioned lead payload from the database (source of truth), not from model output. */
export async function buildLeadPayload(orgId: string, leadId: string, event: string, extra: Record<string, unknown> = {}) {
  const l = await one<Record<string, unknown>>(`SELECT * FROM leads WHERE id = $1 AND organization_id = $2`, [leadId, orgId]);
  if (!l) return null;
  const q = (l.qualification ?? {}) as Record<string, unknown>;
  const consent = (l.consent ?? {}) as Record<string, unknown>;
  return {
    source: "utilmo_ai_assistant",
    schema_version: PAYLOAD_SCHEMA_VERSION,
    event,
    lead: {
      id: l.id, first_name: l.first_name, last_name: l.last_name, email: l.email_normalized, phone: l.phone_e164, language: l.language,
      brokerage: l.brokerage, city: l.city, territory: l.territory, user_type: l.user_type,
      existing_customer: l.existing_customer === "yes" ? true : l.existing_customer === "no" ? false : null,
      services_interest: l.services_interest, main_goal: q.main_goal ?? null, timeline: q.timeline ?? null, current_crm: q.current_crm ?? null,
      website_status: q.website_status ?? null, lead_methods: q.lead_methods ?? null, biggest_challenge: q.biggest_challenge ?? null,
      lead_volume: q.lead_volume ?? null, demo_interest: q.demo_interest ?? null, score: l.score, priority: l.priority,
      score_reasons: q.score_reasons ?? [], status: l.status, created_at: l.created_at, updated_at: l.updated_at,
    },
    conversation: { session_id: extra.conversation_id ?? null, summary: l.summary ?? null, admin_url: extra.admin_url ?? null },
    consent: { contact_requested: !!consent.contact_requested, privacy_notice_acknowledged: !!consent.privacy_notice_acknowledged, notice_version: consent.notice_version ?? null },
  };
}

/** Queue a delivery for every enabled integration subscribed to the event, then attempt immediately. */
export async function enqueueEvent(orgId: string, assistantId: string, event: WebhookEvent, data: Record<string, unknown>, idempotencyKey: string): Promise<string[]> {
  const ints = await many<Integration>(
    `SELECT * FROM integrations WHERE organization_id = $1 AND (assistant_id IS NULL OR assistant_id = $2) AND enabled AND type IN ('webhook','zapier','make','highlevel','email','utilmo_crm')`,
    [orgId, assistantId]);
  const ids: string[] = [];
  for (const it of ints) {
    const events = it.config.events ?? [];
    if (events.length && !events.includes(event)) continue;
    let payload: Record<string, unknown> = { source: "utilmo_ai_assistant", schema_version: PAYLOAD_SCHEMA_VERSION, event, ...data };
    if (event.startsWith("lead.") && typeof data.lead_id === "string") payload = (await buildLeadPayload(orgId, data.lead_id, event, data)) ?? payload;
    if (data.admin_url) payload.admin_url = data.admin_url;
    const row = await one<{ id: string }>(
      `INSERT INTO webhook_deliveries (organization_id, integration_id, event, idempotency_key, payload) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (integration_id, idempotency_key) DO NOTHING RETURNING id`,
      [orgId, it.id, event, idempotencyKey, JSON.stringify(payload)]);
    if (row) ids.push(row.id);
  }
  if (ids.length && typeof data.lead_id === "string") await getDb().query(`UPDATE leads SET sync_status = 'pending' WHERE id = $1 AND organization_id = $2`, [data.lead_id, orgId]);
  await Promise.all(ids.map((id) => attemptDelivery(id).catch((e) => console.warn("[webhook] attempt failed", String(e)))));
  return ids;
}

interface Delivery { id: string; organization_id: string; integration_id: string; event: string; idempotency_key: string; payload: Record<string, unknown>; attempts: number }

function applyMapping(payload: Record<string, unknown>, mapping?: Record<string, string>) {
  if (!mapping || !Object.keys(mapping).length) return payload;
  const out: Record<string, unknown> = {};
  for (const [target, src] of Object.entries(mapping)) out[target] = getPath(payload, src);
  return out;
}

async function send(it: Integration, d: Delivery): Promise<{ status: number; body: string }> {
  const secretValue = it.secret_encrypted ? decrypt(it.secret_encrypted) : "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    if (it.type === "webhook" || it.type === "zapier" || it.type === "make") {
      const url = await assertSafeDestination(it.config.url ?? "");
      const body = JSON.stringify(applyMapping({ ...d.payload, delivery_id: d.id }, it.config.field_mapping));
      const ts = Math.floor(Date.now() / 1000).toString();
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "UtilmoAI-Webhooks/1.0", "idempotency-key": d.idempotency_key, "x-utilmo-event": d.event, "x-utilmo-delivery": d.id };
      if (secretValue) headers["x-utilmo-signature"] = `t=${ts},v1=${hmac(secretValue, `${ts}.${body}`)}`;
      const r = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal, redirect: "error" });
      return { status: r.status, body: (await r.text()).slice(0, 500) };
    }
    if (it.type === "highlevel") {
      // HighLevel API v2 contact upsert (requires a Private Integration token + location id configured by an admin).
      if (!d.event.startsWith("lead.")) return { status: 204, body: "event not applicable" };
      const lead = (d.payload.lead ?? {}) as Record<string, unknown>;
      const r = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
        method: "POST", signal: ctrl.signal,
        headers: { authorization: `Bearer ${secretValue}`, version: "2021-07-28", "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ locationId: it.config.location_id, firstName: lead.first_name, lastName: lead.last_name, email: lead.email, phone: lead.phone, source: "Utilmo AI Assistant", tags: ["utilmo-ai", ...((lead.services_interest as string[]) ?? []).map((s) => s.toLowerCase())] }),
      });
      return { status: r.status, body: (await r.text()).slice(0, 500) };
    }
    if (it.type === "email") {
      const mail = renderEmail(d.event, d.payload);
      const to = (it.config.to ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      if (!to.length) throw new Error("No recipients configured");
      if (it.config.provider === "resend") {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST", signal: ctrl.signal, headers: { authorization: `Bearer ${secretValue}`, "content-type": "application/json", "idempotency-key": d.idempotency_key },
          body: JSON.stringify({ from: it.config.from, to, subject: mail.subject, text: mail.text, html: mail.html }),
        });
        return { status: r.status, body: (await r.text()).slice(0, 500) };
      }
      // SMTP (Google Workspace, Microsoft 365, any provider). Password stored encrypted as the integration secret.
      if (!it.config.smtp_host || !it.config.smtp_user) throw new Error("SMTP host/user not configured");
      const nodemailer = (await import("nodemailer")).default;
      const port = Number(it.config.smtp_port ?? 465);
      const tx = nodemailer.createTransport({ host: it.config.smtp_host, port, secure: port === 465, auth: { user: it.config.smtp_user, pass: secretValue }, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 9000 });
      const info = await tx.sendMail({ from: it.config.from || it.config.smtp_user, to, subject: mail.subject, text: mail.text, html: mail.html, headers: { "X-Utilmo-Event": d.event } });
      const ok = (info.accepted ?? []).length > 0;
      return { status: ok ? 250 : 550, body: `accepted=${(info.accepted ?? []).join(",")} rejected=${(info.rejected ?? []).join(",")}`.slice(0, 500) };
    }
    if (it.type === "utilmo_crm") throw new Error("Utilmo CRM adapter not available: no documented Utilmo CRM API endpoint has been provided. Use a webhook (Zapier/Make) or supply the API documentation.");
    throw new Error(`Unsupported integration type ${it.type}`);
  } finally { clearTimeout(timer); }
}

/** Attempt one delivery. Success is recorded ONLY on a 2xx confirmation from the destination. */
export async function attemptDelivery(deliveryId: string): Promise<"success" | "failed" | "dead" | "skipped"> {
  const d = await one<Delivery>(
    `UPDATE webhook_deliveries SET status = 'delivering', attempts = attempts + 1
     WHERE id = $1 AND status IN ('pending','failed') AND next_attempt_at <= now() RETURNING id, organization_id, integration_id, event, idempotency_key, payload, attempts`, [deliveryId]);
  if (!d) return "skipped";
  const it = await one<Integration>(`SELECT * FROM integrations WHERE id = $1 AND organization_id = $2`, [d.integration_id, d.organization_id]);
  const leadId = ((d.payload.lead as Record<string, unknown> | undefined)?.id ?? d.payload.lead_id) as string | undefined;
  let status = 0, body = "", error: string | null = null;
  try {
    if (!it || !it.enabled) throw new Error("integration disabled");
    ({ status, body } = await send(it, d));
    if ((status < 200 || status >= 300) && status !== 250) error = `HTTP ${status}`;
  } catch (e) { error = (e as Error).message?.slice(0, 300) ?? "error"; }

  if (!error) {
    await getDb().query(`UPDATE webhook_deliveries SET status = 'success', delivered_at = now(), last_status_code = $2, last_error = NULL, response_excerpt = $3 WHERE id = $1`, [d.id, status, body]);
    if (leadId) {
      const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE organization_id = $1 AND payload->'lead'->>'id' = $2 AND status <> 'success'`, [d.organization_id, leadId]);
      if (!pending?.n) await getDb().query(`UPDATE leads SET sync_status = 'synced' WHERE id = $1 AND organization_id = $2`, [leadId, d.organization_id]);
      await getDb().query(`INSERT INTO analytics_events (organization_id, event, properties) VALUES ($1, 'lead_synced', $2)`, [d.organization_id, JSON.stringify({ lead_id: leadId, integration: it?.type })]);
    }
    return "success";
  }
  const dead = d.attempts >= MAX_ATTEMPTS || error.includes("not available") || error.includes("not allowed");
  const delay = BACKOFF_MIN[Math.min(d.attempts - 1, BACKOFF_MIN.length - 1)];
  await getDb().query(
    `UPDATE webhook_deliveries SET status = $2, last_status_code = $3, last_error = $4, response_excerpt = $5, next_attempt_at = now() + make_interval(mins => $6) WHERE id = $1`,
    [d.id, dead ? "dead" : "failed", status || null, error, body || null, delay]);
  if (leadId) await getDb().query(`UPDATE leads SET sync_status = 'failed' WHERE id = $1 AND organization_id = $2`, [leadId, d.organization_id]);
  return dead ? "dead" : "failed";
}

/** Retry due deliveries (called by the scheduled maintenance function). */
export async function retryDueDeliveries(limit = 25) {
  const due = await many<{ id: string }>(`SELECT id FROM webhook_deliveries WHERE status IN ('pending','failed') AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT $1`, [limit]);
  const results: Record<string, number> = {};
  for (const d of due) { const r = await attemptDelivery(d.id); results[r] = (results[r] ?? 0) + 1; }
  // Recover deliveries stuck in "delivering" (function crashed mid-flight).
  await getDb().query(`UPDATE webhook_deliveries SET status = 'failed' WHERE status = 'delivering' AND next_attempt_at < now() - interval '10 minutes'`);
  return results;
}

export async function sendTestEvent(orgId: string, integrationId: string) {
  const key = "test.ping:" + randomToken(8);
  const row = await one<{ id: string }>(
    `INSERT INTO webhook_deliveries (organization_id, integration_id, event, idempotency_key, payload) VALUES ($1,$2,'test.ping',$3,$4) RETURNING id`,
    [orgId, integrationId, key, JSON.stringify({ source: "utilmo_ai_assistant", schema_version: PAYLOAD_SCHEMA_VERSION, event: "test.ping", sent_at: new Date().toISOString() })]);
  const result = await attemptDelivery(row!.id);
  return { deliveryId: row!.id, result };
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Human-readable notification e-mail (French first, the team's language). */
export function renderEmail(event: string, p: Record<string, unknown>): { subject: string; text: string; html: string } {
  const lead = (p.lead ?? {}) as Record<string, unknown>;
  const prof = (p.profile ?? {}) as Record<string, { value?: unknown }>;
  const v = (k: string) => { const x = lead[k] ?? prof[k]?.value; return Array.isArray(x) ? x.join(", ") : x; };
  const name = [v("first_name"), v("last_name")].filter(Boolean).join(" ") || "Visiteur";
  const conv = (p.conversation ?? {}) as Record<string, unknown>;
  const adminUrl = (p.admin_url ?? conv.admin_url) as string | undefined;
  const titles: Record<string, string> = {
    "lead.captured": `Nouveau lead : ${name}`,
    "lead.qualified": `Lead qualifié : ${name}`,
    "support.ticket_created": `Nouvelle demande de soutien #${p.reference ?? ""} : ${name}`,
    "human.requested": `🔔 Un visiteur veut parler à quelqu'un${name !== "Visiteur" ? ` : ${name}` : ""}`,
    "test.ping": "Test des notifications Utilmo AI",
  };
  const subject = `[Utilmo AI] ${titles[event] ?? event}`;
  const rows: [string, unknown][] = [
    ["Nom", name !== "Visiteur" ? name : null], ["Courriel", v("email")], ["Téléphone", v("phone")], ["Agence", v("brokerage")],
    ["Ville / secteur", [v("city"), v("territory")].filter(Boolean).join(" · ")], ["Priorité / objectif", v("main_goal")],
    ["Intérêts", v("services_interest")], ["Score", lead.score != null ? `${lead.score} (${lead.priority})` : null],
    ["Catégorie", p.category], ["Problème", p.description], ["Résumé", conv.summary ?? p.summary], ["Dernier message", p.last_message],
  ].filter(([, x]) => x !== null && x !== undefined && x !== "") as [string, unknown][];
  const intro = event === "human.requested" ? "Un visiteur demande à parler à un membre de l'équipe. Ouvrez la conversation pour lui répondre directement dans le clavardage."
    : event === "support.ticket_created" ? "Un client existant a ouvert une demande de soutien."
    : event === "test.ping" ? "Les notifications par courriel fonctionnent." : "Un nouveau lead a été capté par l'assistant.";
  const text = `${titles[event] ?? event}\n\n${intro}\n\n${rows.map(([k, x]) => `${k} : ${x}`).join("\n")}${adminUrl ? `\n\nOuvrir la conversation : ${adminUrl}` : ""}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d2124;max-width:560px">
<h2 style="color:#4c2b7b;font-size:18px;margin:0 0 8px">${esc(titles[event] ?? event)}</h2><p style="margin:0 0 14px">${esc(intro)}</p>
<table style="border-collapse:collapse;width:100%">${rows.map(([k, x]) => `<tr><td style="padding:6px 10px 6px 0;color:#6b6578;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(x)}</td></tr>`).join("")}</table>
${adminUrl ? `<p style="margin:18px 0 0"><a href="${esc(adminUrl)}" style="background:#f47421;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Ouvrir la conversation</a></p>` : ""}
<p style="margin-top:20px;font-size:12px;color:#8d879a">Envoyé par l'assistant IA Utilmo.</p></div>`;
  return { subject, text, html };
}
