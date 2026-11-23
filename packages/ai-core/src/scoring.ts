import type { AssistantSettings } from "../../shared/src/settings";
import { val, type Profile } from "./profile";

export interface ScoreResult {
  score: number;
  priority: "low" | "medium" | "high";
  breakdown: Record<"intent" | "need" | "timeline" | "contact" | "fit" | "readiness", number>;
  reasons: string[];
  version: number;
}

const SCORING_VERSION = 1;
const SERVICE_FIT = new Set(["LEAD_GENERATION", "CRM", "WEBSITE", "AUTOMATION", "MARKETING", "BRANDING", "AI_ASSISTANT"]);

/** Timeline keywords → fraction of the timeline weight. */
function timelineFactor(t: string | undefined): [number, string] {
  if (!t) return [0, ""];
  const s = t.toLowerCase();
  if (/(immédiat|immediat|maintenant|tout de suite|asap|now|right away|cette semaine|this week|urgent|aujourd|today)/.test(s)) return [1, "Immediate timeline"];
  if (/(30|mois|month|semaines|weeks|bientôt|bientot|soon|prochain)/.test(s)) return [0.8, "Short timeline (≈1–3 months)"];
  if (/(trimestre|quarter|3 ?à ?6|3-6|6 mois|6 months|cette année|this year)/.test(s)) return [0.5, "Medium-term timeline"];
  if (/(pas pressé|no rush|plus tard|later|un jour|someday|explor|curious|curieux|just looking|juste regarder)/.test(s)) return [0.15, "No defined timeline / exploring"];
  return [0.4, "Timeline mentioned"];
}

/**
 * Explainable, configurable 0–100 score. Only business signals are used — never protected
 * characteristics, and purchasing ability is never inferred.
 */
export function scoreLead(p: Profile, settings: AssistantSettings): ScoreResult {
  const w = settings.scoring.weights;
  const reasons: string[] = [];
  const f = p.flags ?? {};
  const b = { intent: 0, need: 0, timeline: 0, contact: 0, fit: 0, readiness: 0 };

  const intentFactor = { none: 0, low: 0.3, medium: 0.65, high: 1 }[f.commercial_intent ?? "none"];
  b.intent = w.intent * intentFactor;
  if (intentFactor >= 0.65) reasons.push("Clear commercial intent");

  const needSignals = [val(p, "main_goal"), val(p, "biggest_challenge")].filter(Boolean).length + (f.clear_need ? 1 : 0);
  b.need = w.need * Math.min(1, needSignals / 2);
  if (needSignals) reasons.push("Clear need or problem stated");

  const [tf, tr] = timelineFactor(val(p, "timeline"));
  b.timeline = w.timeline * tf;
  if (tr) reasons.push(tr);

  const c = [val(p, "first_name"), val(p, "email"), val(p, "phone")].filter(Boolean).length;
  b.contact = w.contact * (c / 3);
  if (c === 3) reasons.push("Complete contact details");
  else if (c > 0) reasons.push("Partial contact details");

  const cats = val(p, "services_interest") ?? [];
  const fitting = cats.filter((x) => SERVICE_FIT.has(x)).length;
  const isBroker = ["broker", "agency", "team_leader"].includes(String(val(p, "user_type") ?? ""));
  b.fit = w.fit * Math.min(1, (fitting ? 0.6 : 0) + (isBroker ? 0.4 : 0) + (val(p, "territory")?.length || val(p, "city") ? 0.2 : 0));
  if (fitting) reasons.push("Relevant service fit");
  if (isBroker) reasons.push("Real estate professional");

  const ready = val(p, "demo_interest") === "yes" || f.contact_requested || f.human_requested;
  b.readiness = ready ? w.readiness : 0;
  if (ready) reasons.push("Ready for a meeting or callback");

  // Existing customers asking for support are not sales leads.
  if (val(p, "existing_customer") === "yes" && cats.includes("CUSTOMER_SUPPORT") && !intentFactor) {
    reasons.push("Existing customer (support) — not scored as a sales lead");
    b.intent = b.need = b.timeline = b.fit = b.readiness = 0;
  }

  const total = Object.values(w).reduce((a, x) => a + x, 0) || 100;
  const raw = Object.values(b).reduce((a, x) => a + x, 0);
  const score = Math.max(0, Math.min(100, Math.round((raw / total) * 100)));
  const t = settings.scoring.thresholds;
  const priority = score >= t.high ? "high" : score >= t.medium ? "medium" : "low";
  for (const k of Object.keys(b) as (keyof typeof b)[]) b[k] = Math.round(b[k] * 10) / 10;
  return { score, priority, breakdown: b, reasons, version: SCORING_VERSION };
}
