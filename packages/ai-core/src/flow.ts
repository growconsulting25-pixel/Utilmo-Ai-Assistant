import type { AssistantSettings, FlowStepKey } from "../../shared/src/settings";
import type { InterestCategory } from "../../shared/src/constants";
import { extractEmails, extractName, extractPhones } from "./extraction";
import { val, type Profile, type ProfileUpdate } from "./profile";

/**
 * Guided qualification flow: a fixed, short sequence (broker? → brokerage → priority → name → phone → e-mail)
 * so the team quickly sees who the visitor is and what they want. Button answers are handled
 * deterministically (instant, no LLM call); free questions are answered briefly and the flow resumes.
 */
type Step = AssistantSettings["guidedFlow"]["steps"][number];
export type FlowFlags = { flow_step?: FlowStepKey | "done"; not_broker?: boolean; flow_skipped?: string[]; support_mode?: boolean };

const YES = /^\s*(oui|yes|ouais|yep|yeah|absolument|exact|correct|tout à fait|bien sûr|of course|sure|je suis courtier|i am a broker|i'm a broker)\b/i;
const NO = /^\s*(non|no|nope|pas vraiment|not really)\b/i;
const REFUSE = /(préf[eè]re(rais)? (ne )?pas|rather not|pas maintenant|not now|plus tard|later|non merci|no thanks|skip|passer)/i;

const GOAL_CATS: [RegExp, InterestCategory][] = [
  [/(lead|prospect|vendeur|acheteur|seller|buyer)/i, "LEAD_GENERATION"],
  [/(visibilit|marketing|publicit|ads|seo|réseaux|social|marque|brand)/i, "MARKETING"],
  [/\bcrm\b|contacts?|pipeline/i, "CRM"],
  [/(automat|suivi|follow|sms|courriels? auto)/i, "AUTOMATION"],
  [/(site|web)/i, "WEBSITE"],
  [/(soutien|support|aide|help|problème|problem)/i, "CUSTOMER_SUPPORT"],
];
export function goalCategories(text: string): InterestCategory[] {
  return GOAL_CATS.filter(([re]) => re.test(text)).map(([, c]) => c);
}

function f(p: Profile): FlowFlags { return (p.flags ?? {}) as FlowFlags; }

export function stepDone(p: Profile, key: FlowStepKey): boolean {
  const fl = f(p);
  if (fl.flow_skipped?.includes(key)) return true;
  switch (key) {
    case "is_broker": return !!val(p, "user_type") || !!fl.not_broker || val(p, "existing_customer") === "yes";
    case "role": return !fl.not_broker || !!val(p, "user_type") || val(p, "existing_customer") === "yes";
    case "brokerage": return !!val(p, "brokerage") || val(p, "user_type") === "other";
    case "main_goal": return !!val(p, "main_goal");
    case "name": return !!val(p, "first_name") || !!p.flags?.contact_refused;
    case "phone": return !!val(p, "phone") || !!p.flags?.contact_refused;
    case "email": return !!val(p, "email") || !!p.flags?.contact_refused;
  }
}

export function currentStep(p: Profile, s: AssistantSettings): Step | null {
  if (!s.guidedFlow.enabled || f(p).flow_step === "done" || f(p).support_mode) return null;
  return s.guidedFlow.steps.find((st) => !stepDone(p, st.key)) ?? null;
}

export function fill(t: string, p: Profile): string {
  const name = val(p, "first_name") ?? "";
  return t.replace(/\{name\}/g, name).replace(/\{brokerage\}/g, val(p, "brokerage") ?? "").replace(/\s+([!?,.])/g, " $1").replace(/ {2,}/g, " ").replace(/Merci\s+!/, "Merci !").replace(/Thanks\s+!/, "Thanks!").trim();
}

export function isOption(step: Step | null, message: string): boolean {
  if (!step) return false;
  const m = message.trim().toLowerCase();
  return [...step.options.fr, ...step.options.en].some((o) => o.toLowerCase() === m);
}

export interface FlowParse { updates: ProfileUpdate; flags: Partial<FlowFlags> & { contact_refused?: boolean; commercial_intent?: "medium"; clear_need?: boolean }; invalid?: "phone" | "email"; answered: boolean }

/** Interpret the visitor's message as an answer to the step that was just asked. */
export function parseFlowAnswer(step: Step, message: string): FlowParse {
  const msg = message.trim();
  const out: FlowParse = { updates: {}, flags: {}, answered: false };
  const src = "user_confirmed" as const;
  const short = msg.length <= 80 && !msg.includes("?");
  switch (step.key) {
    case "is_broker":
      if (YES.test(msg)) { out.updates.user_type = { value: "broker", source: src }; out.answered = true; }
      else if (NO.test(msg)) { out.flags.not_broker = true; out.answered = true; }
      break;
    case "role":
      if (/(agence|agency|équipe|team)/i.test(msg)) { out.updates.user_type = { value: "agency", source: src }; out.answered = true; }
      else if (/(client|customer)/i.test(msg)) { out.updates.existing_customer = { value: "yes", source: src }; out.flags.support_mode = true; out.answered = true; }
      else if (short) { out.updates.user_type = { value: "other", source: src }; out.answered = true; }
      break;
    case "brokerage":
      if (short && msg.length >= 2) { out.updates.brokerage = { value: msg.replace(/^(je suis |je travaille )?(chez|avec|with|at)\s+/i, "").slice(0, 80), source: src }; out.answered = true; }
      break;
    case "main_goal": {
      const cats = goalCategories(msg);
      if (cats.includes("CUSTOMER_SUPPORT")) { out.flags.support_mode = true; out.updates.existing_customer = { value: "yes", source: src }; }
      if (short || cats.length) {
        out.updates.main_goal = { value: msg.slice(0, 200), source: src };
        if (cats.length) out.updates.services_interest = { value: cats, source: src };
        out.flags.commercial_intent = "medium"; out.flags.clear_need = true; out.answered = true;
      }
      break;
    }
    case "name": {
      if (REFUSE.test(msg)) { out.flags.contact_refused = true; out.answered = true; break; }
      const n = extractName(msg);
      const plain = msg.match(/^([A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,30})(?:\s+([A-Za-zÀ-ÖØ-öø-ÿ'’ -]{2,40}))?$/);
      const first = n.first ?? (plain ? plain[1] : undefined);
      const last = n.last ?? (plain ? plain[2]?.trim() : undefined);
      const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
      if (first) { out.updates.first_name = { value: cap(first), source: src }; if (last) out.updates.last_name = { value: last.split(/\s+/).map(cap).join(" "), source: src }; out.answered = true; }
      break;
    }
    case "phone": {
      if (REFUSE.test(msg)) { out.flags.contact_refused = true; out.answered = true; break; }
      const ph = extractPhones(msg)[0];
      if (ph) { out.updates.phone = { value: ph, source: "pattern" }; out.answered = true; }
      else if (/\d{3}/.test(msg)) out.invalid = "phone";
      break;
    }
    case "email": {
      if (REFUSE.test(msg)) { out.flags.contact_refused = true; out.answered = true; break; }
      const em = extractEmails(msg)[0];
      if (em) { out.updates.email = { value: em, source: "pattern" }; out.answered = true; }
      else if (msg.includes("@")) out.invalid = "email";
      break;
    }
  }
  return out;
}

export function stepState(key: FlowStepKey | null): "NEEDS_DISCOVERY" | "SERVICE_RECOMMENDATION" | "CONTACT_CAPTURE" | "LEAD_QUALIFICATION" {
  if (!key) return "LEAD_QUALIFICATION";
  if (key === "main_goal") return "SERVICE_RECOMMENDATION";
  if (key === "name" || key === "phone" || key === "email") return "CONTACT_CAPTURE";
  return "NEEDS_DISCOVERY";
}
