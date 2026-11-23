import type { Config, Context } from "@netlify/functions";
import { decrypt, hmac, safeEqual } from "../../server/crypto";
import { getDb, one } from "../../server/db";
import { json } from "../../server/http";

/**
 * Confirmed bookings from Cal.com (X-Cal-Signature-256) or Calendly (Calendly-Webhook-Signature).
 * "booking_confirmed" is recorded ONLY from a verified scheduling-provider callback — never from the AI.
 */
export default async (req: Request, context: Context) => {
  const id = context.params.id;
  if (!/^[0-9a-f-]{36}$/.test(id ?? "")) return json({ error: "not_found" }, { status: 404 });
  const it = await one<{ id: string; organization_id: string; assistant_id: string; type: string; secret_encrypted: string | null; enabled: boolean }>(
    `SELECT id, organization_id, assistant_id, type, secret_encrypted, enabled FROM integrations WHERE id = $1 AND type IN ('cal_com','calendly')`, [id]);
  if (!it || !it.enabled || !it.secret_encrypted) return json({ error: "not_found" }, { status: 404 });
  const raw = await req.text();
  const key = decrypt(it.secret_encrypted);
  let ok = false;
  if (it.type === "cal_com") ok = safeEqual(req.headers.get("x-cal-signature-256") ?? "", hmac(key, raw));
  else {
    const h = req.headers.get("calendly-webhook-signature") ?? "";
    const t = h.match(/t=(\d+)/)?.[1], v1 = h.match(/v1=([0-9a-f]+)/)?.[1];
    ok = !!t && !!v1 && safeEqual(v1, hmac(key, `${t}.${raw}`)) && Math.abs(Date.now() / 1000 - Number(t)) < 600;
  }
  if (!ok) return json({ error: "invalid_signature" }, { status: 401 });
  const ev = JSON.parse(raw) as Record<string, any>;
  const type = it.type === "cal_com" ? ev.triggerEvent : ev.event;
  const created = ["BOOKING_CREATED", "invitee.created"].includes(type);
  const cancelled = ["BOOKING_CANCELLED", "invitee.canceled"].includes(type);
  if (!created && !cancelled) return json({ ignored: type });
  const p = ev.payload ?? {};
  const email = (it.type === "cal_com" ? p.attendees?.[0]?.email : p.email)?.toLowerCase() ?? null;
  const start = it.type === "cal_com" ? p.startTime : p.scheduled_event?.start_time;
  const extId = it.type === "cal_com" ? String(p.uid ?? p.bookingId ?? "") : String(p.uri ?? "");
  const lead = email ? await one<{ id: string }>(`SELECT id FROM leads WHERE organization_id = $1 AND email_normalized = $2`, [it.organization_id, email]) : null;
  await getDb().query(`INSERT INTO bookings (organization_id, assistant_id, lead_id, provider, status, external_id, scheduled_at, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [it.organization_id, it.assistant_id, lead?.id ?? null, it.type, created ? "confirmed" : "cancelled", extId, start ?? null, JSON.stringify({ type })]);
  if (created) await getDb().query(`INSERT INTO analytics_events (organization_id, assistant_id, event, properties) VALUES ($1,$2,'booking_confirmed',$3)`, [it.organization_id, it.assistant_id, JSON.stringify({ lead_id: lead?.id ?? null, provider: it.type })]);
  return json({ ok: true });
};
export const config: Config = { path: "/api/booking/webhook/:id", method: "POST" };
