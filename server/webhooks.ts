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

/** Send one e-mail through an e-mail integration (SMTP or Resend). Returns 250/2xx on acceptance. */
export async function sendMail(it: Integration, secretValue: string, to: string[], mail: { subject: string; text: string; html: string }, idempotencyKey: string, signal?: AbortSignal): Promise<{ status: number; body: string }> {
  if (!to.length) throw new Error("No recipients configured");
  if (it.config.provider === "resend") {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", signal, headers: { authorization: `Bearer ${secretValue}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ from: it.config.from, to, subject: mail.subject, text: mail.text, html: mail.html }),
    });
    return { status: r.status, body: (await r.text()).slice(0, 500) };
  }
  if (!it.config.smtp_host || !it.config.smtp_user) throw new Error("SMTP host/user not configured");
  const nodemailer = (await import("nodemailer")).default;
  const port = Number(it.config.smtp_port ?? 465);
  const tx = nodemailer.createTransport({ host: it.config.smtp_host, port, secure: port === 465, auth: { user: it.config.smtp_user, pass: secretValue }, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 9000 });
  const info = await tx.sendMail({ from: it.config.from || it.config.smtp_user, to, subject: mail.subject, text: mail.text, html: mail.html });
  const ok = (info.accepted ?? []).length > 0;
  return { status: ok ? 250 : 550, body: `accepted=${(info.accepted ?? []).join(",")} rejected=${(info.rejected ?? []).join(",")}`.slice(0, 500) };
}

/** Transactional e-mail (password reset, invitation) using the organization's configured sender. */
export async function sendSystemEmail(orgId: string, to: string, mail: { subject: string; text: string; html: string }): Promise<boolean> {
  const it = await one<Integration>(`SELECT * FROM integrations WHERE organization_id = $1 AND type = 'email' AND secret_encrypted IS NOT NULL ORDER BY enabled DESC, created_at LIMIT 1`, [orgId]);
  if (!it) return false;
  try {
    const r = await sendMail(it, decrypt(it.secret_encrypted!), [to], mail, "system:" + randomToken(8));
    return r.status === 250 || (r.status >= 200 && r.status < 300);
  } catch (e) { console.warn("[mail] system email failed", String(e).slice(0, 200)); return false; }
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
      return await sendMail(it, secretValue, to, mail, d.idempotency_key, ctrl.signal);
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

const CAT_FR: Record<string, string> = { LEAD_GENERATION: "Génération de leads", CRM: "CRM", WEBSITE: "Site web", AUTOMATION: "Automatisation", MARKETING: "Marketing / visibilité", BRANDING: "Image de marque", AI_ASSISTANT: "IA", CUSTOMER_SUPPORT: "Soutien", GENERAL_INFORMATION: "Information", OTHER: "Autre" };

/** Branded notification e-mail (Utilmo design, table-based for e-mail clients, French first). */
export function renderEmail(event: string, p: Record<string, unknown>): { subject: string; text: string; html: string } {
  const lead = (p.lead ?? {}) as Record<string, unknown>;
  const prof = (p.profile ?? {}) as Record<string, { value?: unknown }>;
  const v = (k: string) => { const x = lead[k] ?? prof[k]?.value; return Array.isArray(x) ? x.join(", ") : x; };
  const name = [v("first_name"), v("last_name")].filter(Boolean).join(" ");
  const conv = (p.conversation ?? {}) as Record<string, unknown>;
  const adminUrl = (p.admin_url ?? conv.admin_url) as string | undefined;
  let base = "https://utilmo-ai-assistant.netlify.app";
  try { if (adminUrl) base = new URL(adminUrl).origin; } catch { /* */ }
  const meta: Record<string, { emoji: string; label: string; title: string; intro: string; color: string; cta: string }> = {
    "lead.captured": { emoji: "✨", label: "Nouveau lead", title: name ? `${name} a laissé ses coordonnées` : "Nouveau lead capté", intro: "Un visiteur a partagé ses coordonnées avec l'assistant. Voici son profil.", color: "#4c2b7b", cta: "Voir la conversation" },
    "lead.qualified": { emoji: "🔥", label: "Lead qualifié", title: name ? `${name} est un lead qualifié` : "Nouveau lead qualifié", intro: "Ce lead correspond à vos critères de qualification. C'est le bon moment pour le contacter.", color: "#f47421", cta: "Voir le lead" },
    "support.ticket_created": { emoji: "🛟", label: `Demande de soutien${p.reference ? ` #${p.reference}` : ""}`, title: name ? `${name} a besoin d'aide` : "Nouvelle demande de soutien", intro: "Un client existant a ouvert une demande de soutien depuis l'assistant.", color: "#4c2b7b", cta: "Voir la demande" },
    "human.requested": { emoji: "🔔", label: "Parler à quelqu'un", title: name ? `${name} veut parler à un conseiller` : "Un visiteur veut parler à un conseiller", intro: "Le visiteur attend dans le clavardage. Ouvrez la conversation et cliquez « Prendre le relais » pour lui répondre en direct.", color: "#f47421", cta: "Répondre maintenant" },
    "test.ping": { emoji: "✅", label: "Test", title: "Les notifications fonctionnent", intro: "Ce courriel confirme que l'envoi des notifications de l'assistant Utilmo est bien configuré.", color: "#22a861", cta: "Ouvrir l'administration" },
  };
  const m = meta[event] ?? { emoji: "•", label: event, title: event, intro: "", color: "#4c2b7b", cta: "Ouvrir" };
  const subject = `${m.emoji} ${m.title}`;
  const rows = ([
    ["Nom", name], ["Courriel", v("email")], ["Téléphone", v("phone")], ["Agence", v("brokerage")],
    ["Secteur", Array.from(new Set([v("city"), ...String(v("territory") ?? "").split(", ")].filter(Boolean))).join(", ")], ["Priorité", v("main_goal")],
    ["Intérêts", String(v("services_interest") ?? "").split(", ").filter(Boolean).map((c) => CAT_FR[c] ?? c).join(", ")], ["Score", lead.score != null ? `${lead.score}/100 · ${({ high: "élevée", medium: "moyenne", low: "faible" } as Record<string, string>)[String(lead.priority)] ?? lead.priority}` : null],
    ["Type de client", ({ broker: "Courtier", agency: "Agence / équipe", team_leader: "Chef d'équipe", other: "Autre" } as Record<string, string>)[String(v("user_type"))] ?? v("user_type")],
    ["Client existant", v("existing_customer") === true || v("existing_customer") === "yes" ? "Oui" : v("existing_customer") === false || v("existing_customer") === "no" ? "Non" : null],
    ["Langue", v("language") === "en" ? "Anglais" : v("language") === "fr" ? "Français" : null],
    ["Échéancier", v("timeline")], ["CRM actuel", v("current_crm")], ["Site web actuel", v("website_status")],
    ["Sources de leads", v("lead_methods")], ["Défi principal", v("biggest_challenge")], ["Volume", v("lead_volume")],
    ["Intérêt pour une démo", v("demo_interest") === "yes" ? "Oui" : v("demo_interest") === "no" ? "Non" : null],
    ["Pourquoi ce score", Array.isArray(lead.score_reasons) && lead.score_reasons.length ? (lead.score_reasons as string[]).join(" · ") : null],
    ["Catégorie", p.category], ["Problème", p.description], ["Dernier message", p.last_message],
  ] as [string, unknown][]).filter(([, x]) => x !== null && x !== undefined && x !== "");
  const summary = (conv.summary ?? p.summary) as string | undefined;
  const link = adminUrl ?? `${base}/admin/`;
  const text = `${m.title}\n\n${m.intro}\n\n${rows.map(([k, x]) => `${k} : ${x}`).join("\n")}${summary ? `\n\nRésumé : ${summary}` : ""}\n\n${m.cta} : ${link}\n\n— Assistant IA Utilmo`;
  const mailto = (x: unknown) => `<a href="mailto:${esc(x)}" style="color:#4c2b7b;text-decoration:none;font-weight:600">${esc(x)}</a>`;
  const tel = (x: unknown) => `<a href="tel:${esc(String(x).replace(/[^\d+]/g, ""))}" style="color:#4c2b7b;text-decoration:none;font-weight:600">${esc(x)}</a>`;
  const cell = (k: string, x: unknown) => (k === "Courriel" ? mailto(x) : k === "Téléphone" ? tel(x) : esc(x));
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f1f8;font-family:Montserrat,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d2124">
<div style="display:none;max-height:0;overflow:hidden">${esc(m.intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1f8;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
 <tr><td style="padding:0 4px 18px"><table role="presentation" width="100%"><tr>
  <td><img src="${base}/brand/utilmo-logo_2024.png" width="104" alt="utilmo" style="display:block;border:0;height:auto"></td>
  <td align="right" style="font-size:12px;color:#8d879a">Assistant IA</td></tr></table></td></tr>
 <tr><td style="background:#ffffff;border-radius:18px;box-shadow:0 8px 28px rgba(76,43,123,.10);overflow:hidden">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
   <tr><td style="height:5px;background:${m.color};font-size:0;line-height:0">&nbsp;</td></tr>
   <tr><td style="padding:28px 30px 8px">
     <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;padding-right:12px"><img src="${base}/brand/utilmo-bot.png" width="46" height="46" alt="" style="display:block;border:0;border-radius:50%;background:#f4f1f8"></td>
      <td style="vertical-align:middle"><span style="display:inline-block;background:${m.color}1a;color:${m.color};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:5px 10px;border-radius:999px">${m.emoji} ${esc(m.label)}</span></td>
     </tr></table>
     <h1 style="margin:18px 0 8px;font-family:Poppins,Montserrat,'Segoe UI',Arial,sans-serif;font-size:22px;line-height:1.3;color:#1d2124">${esc(m.title)}</h1>
     <p style="margin:0;font-size:15px;line-height:1.6;color:#5f5a6b">${esc(m.intro)}</p>
   </td></tr>
   ${rows.length ? `<tr><td style="padding:18px 30px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ebe7f1;border-radius:12px">
     ${rows.map(([k, x], i) => `<tr><td style="padding:11px 14px;font-size:13px;color:#8d879a;width:120px;vertical-align:top;${i ? "border-top:1px solid #ebe7f1;" : ""}">${esc(k)}</td><td style="padding:11px 14px;font-size:14px;color:#1d2124;vertical-align:top;${i ? "border-top:1px solid #ebe7f1;" : ""}">${cell(k, x)}</td></tr>`).join("")}
   </table></td></tr>` : ""}
   ${summary ? `<tr><td style="padding:16px 30px 0"><div style="background:#f6f3fa;border-radius:12px;padding:14px 16px;font-size:14px;line-height:1.55;color:#3d3747"><strong style="color:#4c2b7b">Résumé de la conversation</strong><br>${esc(summary)}</div></td></tr>` : ""}
   <tr><td align="left" style="padding:24px 30px 30px">
     <a href="${esc(link)}" style="display:inline-block;background:#f47421;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:13px 22px;border-radius:12px">${esc(m.cta)} →</a>
   </td></tr>
  </table>
 </td></tr>
 <tr><td align="center" style="padding:20px 10px 0;font-size:12px;line-height:1.6;color:#8d879a">
   Envoyé automatiquement par l'assistant IA <strong style="color:#4c2b7b">Utilmo</strong><br>3737 Crémazie-Est, #401, Montréal · 514-360-2187 · support@utilmo.ca<br>
   <a href="${base}/admin/#/notifications" style="color:#8d879a">Gérer les notifications</a>
 </td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

/** Branded layout for account e-mails (reset, invitation). */
export function accountEmail(base: string, kind: "reset" | "invite", link: string, extra: { inviter?: string; org?: string } = {}): { subject: string; text: string; html: string } {
  const t = kind === "reset"
    ? { subject: "🔐 Réinitialisez votre mot de passe Utilmo AI", title: "Réinitialiser votre mot de passe", intro: "Vous avez demandé à réinitialiser le mot de passe de votre accès à l'administration de l'assistant Utilmo. Ce lien est valide pendant 1 heure et ne peut servir qu'une fois.", cta: "Choisir un nouveau mot de passe", note: "Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel : votre mot de passe actuel reste inchangé." }
    : { subject: "👋 Invitation à l'administration Utilmo AI", title: "Vous êtes invité à l'administration Utilmo AI", intro: `${extra.inviter ? `${extra.inviter} vous a invité` : "Vous avez été invité"} à gérer l'assistant IA${extra.org ? ` de ${extra.org}` : ""} : leads, conversations, base de connaissances et paramètres. Choisissez votre mot de passe pour activer votre accès (lien valide 72 heures).`, cta: "Activer mon accès", note: "Si vous ne vous attendiez pas à cette invitation, ignorez ce courriel." };
  const text = `${t.title}\n\n${t.intro}\n\n${t.cta} : ${link}\n\n${t.note}\n\n— Assistant IA Utilmo`;
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f1f8;font-family:Montserrat,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d2124">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1f8;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
 <tr><td style="padding:0 4px 18px"><img src="${base}/brand/utilmo-logo_2024.png" width="104" alt="utilmo" style="display:block;border:0;height:auto"></td></tr>
 <tr><td style="background:#ffffff;border-radius:18px;box-shadow:0 8px 28px rgba(76,43,123,.10);overflow:hidden">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
   <tr><td style="height:5px;background:#4c2b7b;font-size:0;line-height:0">&nbsp;</td></tr>
   <tr><td align="center" style="padding:30px 30px 6px"><img src="${base}/brand/utilmo-bot.png" width="64" height="64" alt="" style="display:block;border:0"></td></tr>
   <tr><td align="center" style="padding:6px 30px 0"><h1 style="margin:10px 0 10px;font-family:Poppins,Montserrat,'Segoe UI',Arial,sans-serif;font-size:21px;line-height:1.3">${esc(t.title)}</h1>
     <p style="margin:0;font-size:15px;line-height:1.6;color:#5f5a6b">${esc(t.intro)}</p></td></tr>
   <tr><td align="center" style="padding:24px 30px 10px"><a href="${esc(link)}" style="display:inline-block;background:#f47421;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:13px 24px;border-radius:12px">${esc(t.cta)}</a></td></tr>
   <tr><td align="center" style="padding:6px 30px 28px;font-size:12px;line-height:1.6;color:#8d879a">${esc(t.note)}<br><span style="word-break:break-all">${esc(link)}</span></td></tr>
  </table></td></tr>
 <tr><td align="center" style="padding:20px 10px 0;font-size:12px;line-height:1.6;color:#8d879a">Assistant IA <strong style="color:#4c2b7b">Utilmo</strong> · 3737 Crémazie-Est, #401, Montréal · 514-360-2187</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: t.subject, text, html };
}
