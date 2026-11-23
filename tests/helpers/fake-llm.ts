/**
 * TEST DOUBLE — deterministic stand-in for the LLM used by automated tests only.
 * It lets us test orchestration, persistence, scoring, policy and security deterministically.
 * Real-model quality is measured separately by tests/evals (against the deployed assistant).
 */
import { ScriptedProvider } from "../../packages/ai-core/src/providers/scripted";
import type { JsonRequest, StreamRequest } from "../../packages/ai-core/src/providers/types";

const CITIES = ["Longueuil", "Brossard", "Laval", "Montréal", "Montreal", "Québec", "Quebec", "Gatineau", "Sherbrooke", "Terrebonne", "Toronto"];

function latest(req: JsonRequest): string {
  const c = req.messages[req.messages.length - 1].content;
  return c.match(/<latest_visitor_message>\n([\s\S]*?)\n<\/latest_visitor_message>/)?.[1] ?? c;
}

export function analyze(msg: string) {
  const m = msg.toLowerCase();
  const en = /\b(the|my|i|what|how|do|you|want|need|website|leads?|hello|price|can)\b/.test(m) && !/\b(je|vous|mon|le|la|les|est|des|pour)\b/.test(m);
  const intents: string[] = [];
  const cats: string[] = [];
  if (/\?|comment|combien|how|what|quel|est-ce|does|do you|offrez|offer/.test(m)) intents.push("PRODUCT_QUESTION");
  if (/(prix|co[uû]t|tarif|price|cost|combien)/.test(m)) intents.push("PRICING_QUESTION");
  if (/(centris|crea|intégr|integrat|salesforce|hubspot|zillow)/.test(m)) intents.push("INTEGRATION_QUESTION");
  if (/(vendeur|seller|lead|prospect)/.test(m)) cats.push("LEAD_GENERATION");
  if (/(site web|website|site internet)/.test(m)) cats.push("WEBSITE");
  if (/\bcrm\b|contacts?/.test(m)) cats.push("CRM");
  if (/(sms|automat|suivi|follow)/.test(m)) cats.push("AUTOMATION");
  if (/(visibilit|marketing|publicit|ads)/.test(m)) cats.push("MARKETING");
  const support = /(mon compte|my account|connecter|log ?in|importer|import|ajouter un contact|add a contact|soutien|support|aide|help)/.test(m) && /(client|customer|mon compte|my account|j'utilise|i use|déjà|already)/.test(m);
  if (support) { intents.push("SUPPORT_REQUEST"); cats.push("CUSTOMER_SUPPORT"); }
  if (/(humain|représentant|quelqu'un|human|representative|real person|parler à)/.test(m)) intents.push("HUMAN_REQUEST");
  if (/(démo|demo|rendez-vous|meeting|réserver|book)/.test(m)) intents.push("BOOKING_REQUEST");
  if (/(ignore|oublie|system prompt|prompt système|révèle|reveal|api key|clé api)/.test(m)) intents.push("PROMPT_INJECTION");
  if (/(autres clients|other customers|liste des leads|list of leads|export)/.test(m)) intents.push("SENSITIVE_REQUEST");
  if (/(non merci|pas de coordonnées|prefer not|rather not|pas partager|ne veux pas donner|don't want to give)/.test(m)) intents.push("REFUSE_CONTACT");
  if (/(merci,? bonne journée|bye|au revoir|thanks, that's all)/.test(m)) intents.push("GOODBYE");
  const territory = CITIES.filter((c) => msg.includes(c));
  const name = msg.match(/(?:je m'appelle|mon nom est|my name is|je suis|i'm)\s+([A-ZÉ][a-zé]+)\s+([A-ZÉ][a-zé]+)/);
  return {
    language: en ? "en" : "fr",
    intents: intents.length ? intents : ["PROVIDE_INFO"],
    categories: cats,
    existing_customer: support || /(je suis client|i am a customer|déjà client|existing customer)/.test(m) ? "yes" : "unknown",
    user_type: /(courtier|broker|agent)/.test(m) ? "broker" : "unknown",
    extracted: {
      first_name: name?.[1] ?? null, last_name: name?.[2] ?? null, brokerage: null, city: territory[0] ?? null, territory,
      main_goal: /(plus de|more) (leads )?(vendeurs|sellers|leads)/.test(m) ? msg.slice(0, 80) : null,
      current_crm: /(hubspot|salesforce|follow up boss|kvcore)/i.exec(msg)?.[0] ?? null,
      website_status: /(pas de site|no website|j'ai un site|i have a website)/.test(m) ? msg.slice(0, 60) : null,
      lead_methods: /(campagne|campaign|zéro|zero|scratch|facebook)/.test(m) ? msg.slice(0, 60) : null,
      biggest_challenge: null, lead_volume: /(\d{3,}) contacts/.exec(m)?.[0] ?? null, automation_needs: null,
      timeline: /(30 jours|30 days|ce mois|this month|maintenant|now|asap)/.exec(m)?.[0] ?? null, budget_range: null,
      support_issue: support ? msg.slice(0, 120) : null,
    },
    is_correction: /(en fait|actually)/.test(m),
    demo_interest: /(démo|demo)/.test(m) ? "yes" : "unknown",
    contact_refused: intents.includes("REFUSE_CONTACT"),
    contact_requested: /(rappel|call me|rappelez|contact me|contactez-moi)/.test(m),
    wants_human: intents.includes("HUMAN_REQUEST"),
    commercial_intent: cats.length ? (intents.includes("BOOKING_REQUEST") ? "high" : "medium") : "none",
    clear_need: cats.length > 0 && !intents.includes("PRODUCT_QUESTION"),
    support_category: support ? "other" : null,
    search_queries: [msg.slice(0, 100)],
  };
}

export function fakeLLM() {
  return new ScriptedProvider({
    json: (req) => {
      if (req.system.startsWith("You analyse ONE turn")) return analyze(latest(req));
      return { answered: /pas l'information|don't have|confirmer|confirm/.test(req.messages[0].content) ? "no" : "yes", unanswered_question: null, conflict: null, summary: "Résumé de test (test double)." };
    },
    reply: (req: StreamRequest) => {
      const ctx = req.messages[req.messages.length - 1].content;
      const lang = /Reply language: English/.test(ctx) ? "en" : "fr";
      const ask = ctx.match(/ask ONE question to learn: ([^.]+)\./)?.[1];
      const sources = [...ctx.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
      const parts = [lang === "en" ? "[TEST DOUBLE] Answer." : "[TEST DOUBLE] Réponse."];
      if (sources.length) parts.push(`Sources: ${sources.slice(0, 2).join(" | ")}.`);
      if (/declined to share contact/.test(ctx)) parts.push("(respecting refusal)");
      if (/tried to obtain confidential information/.test(ctx)) parts.push(lang === "en" ? "I can't share internal configuration." : "Je ne peux pas partager la configuration interne.");
      if (/<open_conflicts>/.test(ctx)) parts.push("[conflicts-flagged]");
      if (ask) parts.push(`ASK[${ask}]`);
      return parts.join(" ");
    },
  });
}
