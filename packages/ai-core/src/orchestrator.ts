import type { ChatAction, ChatStreamEvent } from "../../shared/src/protocol";
import type { ConversationState, InterestCategory } from "../../shared/src/constants";
import type { AssistantSettings } from "../../shared/src/settings";
import { AnalysisSchema, ANALYZER_SYSTEM, analysisJsonSchema, analysisToUpdates, fallbackAnalysis, type Analysis } from "./analysis";
import { detectLanguage, extractContact } from "./extraction";
import { containsSensitiveSecret, looksLikeInjection, redactSecrets } from "./injection";
import { decide, markAsked, type PolicyDecision } from "./policy";
import { currentStep, fill, isOption, parseFlowAnswer, parseSupportAnswer, stepState, supportQuestion, supportStep, type FlowParse } from "./flow";
import { hasContact, mergeProfile, profileForPrompt, val, type Profile, type ProfileUpdate } from "./profile";
import { buildSystemPrompt, buildTurnContext, EVALUATOR_SYSTEM, evaluatorJsonSchema, type OpenConflict, type RetrievedChunk } from "./prompts";
import { recommendServices, type Recommendation, type ServiceDef } from "./recommend";
import { scoreLead, type ScoreResult } from "./scoring";
import type { LLMMessage, LLMProvider, LLMUsage } from "./providers/types";

export interface ConversationRecord {
  id: string; visitorId: string; leadId: string | null; state: ConversationState; language: "fr" | "en";
  profile: Profile; summary: string | null; messageCount: number; unresolvedCount: number; intents: string[];
  escalationStatus: string; score: number;
}

export interface LeadUpsert {
  profile: Profile; language: "fr" | "en"; score: ScoreResult; status: "contact_captured" | "qualified" | "support";
  consent: { contact_requested: boolean; privacy_notice_acknowledged: boolean; notice_version: string; captured_at: string };
  summary: string | null;
}

/** Persistence port implemented by server/repo.ts (SQL) and in-memory/PGlite in tests. */
export interface ChatStore {
  recentMessages(conversationId: string, limit: number): Promise<{ role: "user" | "assistant"; content: string }[]>;
  addMessage(conversationId: string, role: "user" | "assistant", content: string, metadata: Record<string, unknown>, clientMessageId?: string): Promise<string>;
  updateConversation(conversationId: string, patch: Partial<ConversationRecord> & { previousState?: string; incrementMessages?: number; lastMessageAt?: Date }): Promise<void>;
  upsertLead(conv: ConversationRecord, lead: LeadUpsert): Promise<{ leadId: string; created: boolean; previousStatus: string | null; previousScore: number | null }>;
  recordScore(leadId: string, conversationId: string, score: ScoreResult): Promise<void>;
  createTicket(conv: ConversationRecord, t: { category: string; description: string; priority: string; history: { role: string; content: string }[]; summary: string | null; leadId: string | null }): Promise<string>;
  recordRecommendations(conversationId: string, recs: Recommendation[]): Promise<string[]>; // returns newly recorded keys
  openConflicts(): Promise<OpenConflict[]>;
  track(event: string, props: Record<string, unknown>, conversationId?: string): Promise<void>;
  recordUsage(model: string, usage: LLMUsage, latencyMs: number): Promise<void>;
  addUnanswered(conversationId: string, question: string, language: string, reason: string): Promise<void>;
  addConflict(conversationId: string, description: string): Promise<void>;
}

export interface TurnDeps {
  settings: AssistantSettings;
  llm: LLMProvider;
  store: ChatStore;
  services: ServiceDef[];
  search: (queries: string[], opts: { collection: "sales" | "support"; topK: number }) => Promise<RetrievedChunk[]>;
  emitWebhook: (event: "lead.captured" | "lead.qualified" | "support.ticket_created" | "human.requested", payload: Record<string, unknown>, idempotencyKey: string) => Promise<void>;
  background: (p: Promise<unknown>) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface TurnInput {
  conversation: ConversationRecord;
  message: string;
  clientMessageId: string;
  languageHint?: "fr" | "en";
  /** Set when the user message was already persisted by an earlier failed attempt (retry). */
  userMessageAlreadyStored?: boolean;
}

const FALLBACK_REPLY = {
  fr: "Désolé, je n'arrive pas à répondre pour le moment. Vous pouvez réessayer dans un instant ou joindre l'équipe Utilmo directement.",
  en: "Sorry, I can't answer right now. Please try again in a moment or contact the team directly.",
};
const REFUSAL_REPLY = {
  fr: "Je ne peux pas aider avec cette demande. Puis-je vous renseigner sur nos solutions ou vous mettre en contact avec l'équipe ?",
  en: "I can't help with that request. Can I tell you about our solutions or connect you with the team?",
};

export async function runTurn(deps: TurnDeps, input: TurnInput, emit: (e: ChatStreamEvent) => void): Promise<{ assistantMessageId: string; state: ConversationState }> {
  const t0 = Date.now();
  const { settings: s, store, llm } = deps;
  const conv = input.conversation;
  const log = deps.log ?? (() => {});

  // 1) Sanitise and persist the visitor message.
  const hadSecret = containsSensitiveSecret(input.message);
  const message = redactSecrets(input.message).slice(0, s.limits.maxMessageChars);
  if (!input.userMessageAlreadyStored) {
    await store.addMessage(conv.id, "user", message, { redacted: hadSecret }, input.clientMessageId);
  }
  emit({ type: "status", status: "thinking" });
  const history = (await store.recentMessages(conv.id, 16)).map((m) => ({ ...m, content: m.content.slice(0, 2500) }));
  const userTurns = history.filter((m) => m.role === "user").length;
  if (userTurns === 1) void store.track("chat_started", {}, conv.id);
  void store.track("message_sent", { chars: message.length }, conv.id);

  // 2) Deterministic extraction (high confidence).
  const patternUpdates = extractContact(message);

  // 3) LLM analysis (structured, validated) with deterministic fallback.
  let analysis: Analysis;
  const fallbackLang = input.languageHint ?? conv.language ?? s.behavior.defaultLanguage;
  const askedStep = currentStep(conv.profile ?? {}, s);
  const supCats = [...s.guidedFlow.support.categories.fr, ...s.guidedFlow.support.categories.en].map((x) => x.toLowerCase());
  const chipAnswer = isOption(askedStep, message) || (supportStep(conv.profile ?? {}) === "category" && supCats.includes(message.trim().toLowerCase()));
  if (chipAnswer) {
    // Button answer in the guided flow: no LLM analysis needed (instant reply).
    const lang = askedStep && askedStep.options.en.some((o) => o.toLowerCase() === message.trim().toLowerCase()) && !askedStep.options.fr.some((o) => o.toLowerCase() === message.trim().toLowerCase()) ? "en" : (conv.language ?? fallbackLang);
    analysis = { ...fallbackAnalysis(lang, message), intents: ["PROVIDE_INFO"], search_queries: [], wants_human: false };
  } else try {
    const transcript = history.slice(-7, -1).map((m) => `${m.role === "user" ? "Visitor" : "Assistant"}: ${m.content.slice(0, 600)}`).join("\n");
    const res = await llm.json({
      model: s.ai.analysisModel, system: ANALYZER_SYSTEM, maxTokens: 900, timeoutMs: 15_000, schema: analysisJsonSchema(),
      messages: [{ role: "user", content: `<earlier_turns>\n${transcript || "(none)"}\n</earlier_turns>\n<latest_visitor_message>\n${message}\n</latest_visitor_message>` }],
    });
    void store.recordUsage(res.model, res.usage, 0);
    const parsed = AnalysisSchema.safeParse(res.data);
    if (!parsed.success) throw new Error("invalid analysis: " + parsed.error.message.slice(0, 200));
    analysis = parsed.data;
  } catch (err) {
    log("analysis_failed", { error: String(err).slice(0, 300) });
    analysis = fallbackAnalysis(detectLanguage(message, fallbackLang), message);
  }
  // Language: trust the analyser, but cross-check very short messages with the previous language.
  let language: "fr" | "en" = analysis.language;
  if (!chipAnswer && message.trim().split(/\s+/).length <= 2 && !/[a-z]{4,}/i.test(message.replace(/@\S+/g, ""))) language = conv.language ?? fallbackLang;
  const langs = s.behavior.languages;
  if (!langs.autoDetect) language = input.languageHint && langs.enabled.includes(input.languageHint) ? input.languageHint : s.behavior.defaultLanguage;
  if (!langs.enabled.includes(language)) language = langs.enabled.includes(s.behavior.defaultLanguage) ? s.behavior.defaultLanguage : langs.enabled[0];
  if (/^(parler à (un conseiller|quelqu'un|un humain)|talk to (an advisor|someone|a human))$/i.test(message.trim())) {
    analysis = { ...analysis, wants_human: true, intents: Array.from(new Set([...analysis.intents, "HUMAN_REQUEST" as const])) };
  }
  if (looksLikeInjection(message) && !analysis.intents.includes("PROMPT_INJECTION")) analysis.intents.push("PROMPT_INJECTION");
  if (hadSecret && !analysis.intents.includes("SENSITIVE_REQUEST")) analysis.intents.push("SENSITIVE_REQUEST");
  if (analysis.intents.length) void store.track("intent_detected", { intents: analysis.intents, categories: analysis.categories }, conv.id);

  // 4) Merge profile (pattern > llm), never overwriting confirmed data with weaker guesses.
  const llmUpdates = analysisToUpdates(analysis);
  const updates: ProfileUpdate = { ...llmUpdates, ...Object.fromEntries(Object.entries(patternUpdates).filter(([, v]) => v)) };
  let { profile } = mergeProfile(conv.profile ?? {}, updates);
  const flags = { ...(profile.flags ?? {}) };
  const volunteeredContact = !!(patternUpdates.email || patternUpdates.phone);
  if (analysis.contact_refused && !volunteeredContact) flags.contact_refused = true;
  if (volunteeredContact) flags.contact_refused = false;
  if (analysis.contact_requested) flags.contact_requested = true;
  if (analysis.wants_human) flags.human_requested = true;
  const rank = { none: 0, low: 1, medium: 2, high: 3 } as const;
  if (rank[analysis.commercial_intent] > rank[flags.commercial_intent ?? "none"]) flags.commercial_intent = analysis.commercial_intent;
  if (analysis.clear_need) flags.clear_need = true;
  profile = { ...profile, flags };

  // 4b) Guided flow: interpret the answer to the step that was asked.
  const securityTurn = analysis.intents.includes("PROMPT_INJECTION") || analysis.intents.includes("SENSITIVE_REQUEST");
  let flowParse: FlowParse | null = null;
  if (askedStep && !securityTurn) {
    flowParse = parseFlowAnswer(askedStep, message);
    profile = mergeProfile(profile, flowParse.updates).profile;
    const ff = flowParse.flags;
    profile.flags = { ...(profile.flags ?? {}), ...ff };
    if (ff.commercial_intent && rank[ff.commercial_intent] > rank[profile.flags.commercial_intent ?? "none"]) profile.flags.commercial_intent = ff.commercial_intent;
  }
  // 4c) Support funnel (existing customers): category → issue → name → contact → ticket.
  const askedSup = supportStep(conv.profile ?? {});
  let supParse: ReturnType<typeof parseSupportAnswer> | null = null;
  if (askedSup && !securityTurn && !isOption(askedStep, message)) {
    supParse = parseSupportAnswer(askedSup, message, s);
    profile = mergeProfile(profile, supParse.updates).profile;
    if (supParse.category) profile.flags = { ...(profile.flags ?? {}), support_category: supParse.category };
  }
  if (!securityTurn && !profile.flags?.support_mode && profile.flags?.support_step !== "done" && (analysis.intents.includes("SUPPORT_REQUEST") || (val(profile, "existing_customer") === "yes" && analysis.categories.includes("CUSTOMER_SUPPORT")))) {
    profile.flags = { ...(profile.flags ?? {}), support_mode: true, flow_step: "done" };
  }

  // 5) Retrieval (RAG): only what is relevant for this turn.
  const supportMode = !!profile.flags?.support_mode || analysis.intents.includes("SUPPORT_REQUEST") || (val(profile, "existing_customer") === "yes" && (analysis.categories.includes("CUSTOMER_SUPPORT") || !!analysis.support_category));
  const security = securityTurn;
  const isQuestion = !chipAnswer && (message.includes("?") || analysis.intents.some((i) => ["PRODUCT_QUESTION", "PRICING_QUESTION", "INTEGRATION_QUESTION"].includes(i)));
  const justEnteredSupport = !!flowParse?.flags.support_mode;
  const flowActive = s.guidedFlow.enabled && profile.flags?.flow_step !== "done" && !security && !analysis.wants_human && !profile.flags?.support_mode;
  const supportFlowActive = s.guidedFlow.enabled && !!profile.flags?.support_mode && profile.flags?.support_step !== "done" && !security && !analysis.wants_human;
  const nextSup = supportFlowActive ? supportStep(profile) : null;
  // Smart booking: count questions; propose an expert after several questions (not after every reply).
  const qCount = (Number((profile.flags as Record<string, unknown>)?.q_since_offer ?? 0)) + (isQuestion ? 1 : 0);
  profile.flags = { ...(profile.flags ?? {}), q_since_offer: qCount } as typeof profile.flags;
  const nextStep = flowActive ? currentStep(profile, s) : null;
  let chunks: RetrievedChunk[] = [];
  if (!security && ((!flowActive && !supportFlowActive) || isQuestion)) {
    const queries = Array.from(new Set([...analysis.search_queries, message.slice(0, 300)])).filter((q) => q.trim().length > 1);
    try {
      chunks = await deps.search(queries, { collection: supportMode ? "support" : "sales", topK: s.ai.retrievalTopK });
    } catch (err) { log("retrieval_failed", { error: String(err).slice(0, 300) }); }
  }
  const supportDocHits = supportMode ? chunks.filter((c) => c.collection === "support" && c.score > 0.05).length : chunks.length;

  // 6) Deterministic policy / state machine.
  const bookingAvailable = s.booking.provider !== "none" && !!s.booking.url;
  let decision: PolicyDecision;
  if (supportFlowActive) {
    const q = nextSup ? supportQuestion(nextSup, s, language, profile) : null;
    decision = {
      state: nextSup ? "EXISTING_CUSTOMER_SUPPORT" : "SUPPORT_ESCALATION", askField: null, handoff: false, saveLead: false, offerBooking: false,
      createTicket: !nextSup && conv.escalationStatus !== "ticket_created",
      guidance: ["This is an existing customer. Answer ONLY their question in 1-2 very short sentences using verified support sources; if no source covers it, say the support team will help. Never invent steps. Do NOT ask any question: the application asks the next step itself."],
      suggestions: q ? { fr: language === "fr" ? q.options : [], en: language === "en" ? q.options : [] } : { fr: [], en: [] },
    };
    if (!nextSup) profile.flags = { ...(profile.flags ?? {}), support_step: "done" };
  } else if (flowActive) {
    const done = !nextStep && !justEnteredSupport;
    decision = {
      state: justEnteredSupport ? "EXISTING_CUSTOMER_SUPPORT" : stepState(nextStep?.key ?? null), askField: null, createTicket: false, handoff: false, saveLead: true,
      // Explicit demo request during the flow: show the booking card right away (the flow continues).
      offerBooking: bookingAvailable && (done || analysis.intents.includes("BOOKING_REQUEST") || analysis.demo_interest === "yes"),
      guidance: ["Answer ONLY the visitor's question, very briefly: one short line, then if listing options use 2-4 bullet points of 2-6 words each (e.g. '- Publicité Meta'). Max 30 words total. Bold the key term. No links, no 'more details here'. If the exact answer (e.g. a price) is not in the sources, just say an advisor will prepare a tailored proposal. Do NOT ask any question: the application asks the next step itself."],
      suggestions: nextStep && !justEnteredSupport ? { fr: nextStep.options.fr, en: nextStep.options.en } : { fr: [], en: [] },
    };
    profile.flags = { ...(profile.flags ?? {}), flow_step: justEnteredSupport ? "done" : (nextStep?.key ?? "done") };
  } else {
    decision = decide({
      previousState: conv.state, analysis, profile, settings: s, userTurns,
      unresolvedCount: conv.unresolvedCount, knowledgeHits: supportMode ? supportDocHits : chunks.length,
      bookingAvailable, ticketAlreadyCreated: conv.escalationStatus === "ticket_created", contactJustProvided: volunteeredContact,
    });
    if (s.guidedFlow.enabled && profile.flags?.flow_step === "done" && !supportMode && !decision.handoff && ["first_name", "phone", "email", "brokerage", "main_goal"].every((k) => k !== decision.askField || true)) {
      // Flow already collected what matters: keep answers short, no further interrogation.
      decision.askField = null;
      decision.guidance = decision.guidance.filter((g) => !/ask ONE question|single missing/.test(g));
      decision.guidance.push("Do not ask further qualification questions. Reply in 1-2 very short sentences (max 30 words), no links. When relevant, invite them to book a demo with the button.");
      // Booking only when it is smart: explicit request (handled by policy), or after several questions.
      if (!supportMode && qCount >= 3) {
        decision.offerBooking = bookingAvailable;
        decision.suggestions = { fr: ["Parler à un conseiller"], en: ["Talk to an advisor"] };
        decision.guidance.push("The visitor has asked several questions: after your short answer, in one short sentence suggest booking a free demo with an expert or talking to an advisor now (buttons are shown below).");
      }
    }
    profile = markAsked(profile, decision.askField);
  }

  // 7) Recommendations (sales only).
  const turnCats = analysis.categories.filter((c) => c !== "GENERAL_INFORMATION") as InterestCategory[];
  const recs = supportMode || security ? [] : recommendServices(deps.services, profile, turnCats, language);
  if (recs.length) {
    const newly = await store.recordRecommendations(conv.id, recs);
    for (const k of newly) void store.track("service_recommended", { service: k }, conv.id);
  }
  const conflicts = await store.openConflicts().catch(() => [] as OpenConflict[]);

  // 8) Generate the grounded reply (streamed).
  const turnContext = buildTurnContext({
    language, state: decision.state, chunks, conflicts: conflicts.slice(0, 6), profileSummary: profileForPrompt(profile),
    recommendations: recs, guidance: decision.guidance, bookingAvailable, showBookingCard: decision.offerBooking && bookingAvailable,
    conversationSummary: history.length > 12 ? conv.summary : null,
  });
  const msgs: LLMMessage[] = history.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") msgs.push({ role: "user", content: message });
  msgs.push({ role: "system", content: turnContext });

  emit({ type: "status", status: "writing" });
  let replyText = "";
  let usage: LLMUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let model = s.ai.responseModel;
  let firstTokenMs = 0;
  // Deterministic text for the guided flow (next question, acknowledgement, completion).
  let flowText = "";
  if (flowActive) {
    const gf = s.guidedFlow;
    if (flowParse?.invalid && askedStep) flowText = `**${(flowParse.invalid === "phone" ? gf.invalidPhone : gf.invalidEmail)[language]}**`;
    else if (justEnteredSupport) flowText = "";
    else if (!nextStep) flowText = fill((profile.flags?.contact_refused ? gf.refusalCompletion : gf.completion)[language], profile);
    else {
      let ack = "";
      if (!isQuestion && flowParse?.answered) {
        if (askedStep?.key === "main_goal") {
          const cats = (val(profile, "services_interest") ?? []) as string[];
          const hl = cats.map((c) => gf.highlights[c]).find(Boolean);
          if (hl && hl[language].length) ack = `${gf.highlightsIntro[language]}\n${hl[language].map((x) => `- ${x}`).join("\n")}`;
          else if (recs[0]) ack = recs[0].why;
        } else if ((askedStep?.key === "is_broker" && flowParse.updates.user_type) || askedStep?.key === "brokerage" || askedStep?.key === "role") ack = language === "fr" ? "Parfait !" : "Great!";
      }
      flowText = [ack, `**${fill(nextStep.question[language], profile)}**`].filter(Boolean).join("\n\n");
    }
    if (flowParse?.invalid && askedStep) decision.suggestions = { fr: askedStep.options.fr, en: askedStep.options.en };
  }
  let supportDonePending = false;
  if (supportFlowActive) {
    const gf = s.guidedFlow;
    if (supParse?.invalid) flowText = `**${(supParse.invalid === "phone" ? gf.invalidPhone : gf.invalidEmail)[language]}**`;
    else if (nextSup) {
      const q = supportQuestion(nextSup, s, language, profile);
      flowText = `**${q.text}**`;
    } else supportDonePending = true;
  }
  if (supportFlowActive && (!isQuestion || supportDonePending)) {
    replyText = supportDonePending ? "" : flowText;
    model = "deterministic-flow";
    if (replyText) emit({ type: "delta", text: replyText });
  } else if (flowActive && !isQuestion) {
    replyText = flowText;
    model = "deterministic-flow";
    emit({ type: "delta", text: replyText });
  } else try {
    const r = await llm.stream({ model: s.ai.responseModel, system: buildSystemPrompt(s), messages: msgs, maxTokens: s.ai.maxOutputTokens, effort: s.ai.effort, timeoutMs: 45_000 }, (d) => {
      if (!firstTokenMs) firstTokenMs = Date.now() - t0;
      replyText += d;
      emit({ type: "delta", text: d });
    });
    usage = r.usage; model = r.model;
    if (r.stopReason === "refusal") { replyText = REFUSAL_REPLY[language]; emit({ type: "replace", text: replyText }); }
    else if (!r.text.trim() && !flowText) throw new Error("empty_reply");
    if ((flowActive || supportFlowActive) && flowText) { const add = "\n\n" + flowText; replyText += add; emit({ type: "delta", text: add }); }
  } catch (err) {
    log("generation_failed", { error: String(err).slice(0, 300) });
    // Nothing persisted for the assistant: the client can retry with the same clientMessageId.
    throw Object.assign(new Error("generation_failed"), { cause: err, partial: replyText, language });
  }
  const latency = Date.now() - t0;
  void store.recordUsage(model, usage, latency);

  // 9) Deterministic actions.
  const actions: ChatAction[] = [];
  let leadId = conv.leadId;
  let score: ScoreResult | null = null;
  const contact = hasContact(profile);
  let escalationStatus = conv.escalationStatus;

  if ((contact.email || contact.phone) && (decision.saveLead || volunteeredContact || decision.createTicket)) {
    score = scoreLead(profile, s);
    const isSupport = val(profile, "existing_customer") === "yes" && supportMode;
    const qualified = !isSupport && contact.name && score.score >= s.scoring.qualifiedMinScore;
    const status = isSupport ? "support" : qualified ? "qualified" : "contact_captured";
    const res = await store.upsertLead(conv, {
      profile, language, score, status,
      consent: { contact_requested: !!flags.contact_requested || decision.handoff, privacy_notice_acknowledged: true, notice_version: s.privacy.noticeVersion, captured_at: new Date().toISOString() },
      summary: conv.summary,
    });
    leadId = res.leadId;
    if (res.previousScore !== score.score) await store.recordScore(leadId, conv.id, score);
    const payload = () => ({ lead_id: leadId, conversation_id: conv.id, profile, score, language, summary: conv.summary, consent: { contact_requested: !!flags.contact_requested || decision.handoff, privacy_notice_acknowledged: true } });
    if (res.created || res.previousStatus === "new") {
      actions.push({ type: "contact_saved" });
      void store.track("contact_captured", { lead_id: leadId }, conv.id);
      deps.background(deps.emitWebhook("lead.captured", payload(), `lead.captured:${leadId}`));
    }
    if (status === "qualified" && res.previousStatus !== "qualified") {
      void store.track("lead_qualified", { lead_id: leadId, score: score.score }, conv.id);
      deps.background(deps.emitWebhook("lead.qualified", payload(), `lead.qualified:${leadId}`));
    }
  } else if (contact.name || analysis.commercial_intent !== "none") {
    score = scoreLead(profile, s);
  }

  if (decision.createTicket && escalationStatus !== "ticket_created") {
    const ticketHistory = history.slice(-8).map((m) => ({ role: m.role, content: m.content.slice(0, 800) }));
    const ticketId = await store.createTicket({ ...conv, profile, leadId }, {
      category: (profile.flags?.support_category as string | undefined) ?? analysis.support_category ?? "other",
      description: val(profile, "support_issue") ?? message.slice(0, 1000),
      priority: decision.handoff ? "high" : "normal",
      history: ticketHistory, summary: conv.summary, leadId,
    });
    escalationStatus = "ticket_created";
    const reference = ticketId.slice(0, 8).toUpperCase();
    actions.push({ type: "ticket_created", reference });
    if (supportDonePending) { const t = s.guidedFlow.support.done[language].replace("{ref}", reference); replyText = replyText ? replyText + "\n\n" + t : t; emit({ type: "delta", text: (replyText === t ? "" : "\n\n") + t }); }
    void store.track("support_escalated", { ticket_id: ticketId }, conv.id);
    deps.background(deps.emitWebhook("support.ticket_created", { ticket_id: ticketId, reference, conversation_id: conv.id, lead_id: leadId, category: analysis.support_category ?? "other", description: val(profile, "support_issue") ?? message.slice(0, 1000), profile }, `support.ticket_created:${ticketId}`));
  } else if (supportMode && conv.state !== "EXISTING_CUSTOMER_SUPPORT" && conv.state !== "SUPPORT_ESCALATION") {
    void store.track("support_requested", {}, conv.id);
  }
  if (decision.handoff) {
    if (escalationStatus === "none") {
      escalationStatus = "requested";
      deps.background(deps.emitWebhook("human.requested", { conversation_id: conv.id, lead_id: leadId, profile, last_message: message.slice(0, 500), summary: conv.summary }, `human.requested:${conv.id}`));
    }
    actions.push({ type: "handoff", phone: s.behavior.escalation.salesPhone || s.behavior.escalation.supportPhone || undefined, email: s.behavior.escalation.supportEmail || undefined });
  }
  if (decision.offerBooking && bookingAvailable) profile.flags = { ...(profile.flags ?? {}), q_since_offer: 0 } as typeof profile.flags;
  if (decision.offerBooking && bookingAvailable) actions.push({ type: "booking", url: s.booking.url, label: s.booking.label[language] || s.booking.label.fr });
  const sources = dedupeSources(chunks.filter((c) => c.priority <= 3 && c.url && c.score > 0.05));
  if (sources.length && decision.state !== "CONTACT_CAPTURE" && analysis.intents.some((i) => ["PRODUCT_QUESTION", "PRICING_QUESTION", "INTEGRATION_QUESTION"].includes(i))) {
    actions.push({ type: "sources", items: sources.slice(0, 3) });
  }
  const sugg = decision.suggestions[language].filter(Boolean);
  if (sugg.length && !(decision.askField && ["first_name", "phone", "email"].includes(decision.askField) && contact.name && contact.phone && contact.email)) actions.push({ type: "suggestions", items: sugg });
  if (actions.length) emit({ type: "actions", actions });

  // 10) Persist assistant message and conversation state.
  const assistantMessageId = await store.addMessage(conv.id, "assistant", replyText, {
    state: decision.state, intents: analysis.intents, categories: analysis.categories, ask_field: decision.askField,
    sources: chunks.map((c) => ({ id: c.id, title: c.title, url: c.url, priority: c.priority, score: Math.round(c.score * 1000) / 1000 })),
    recommendations: recs.map((r) => ({ key: r.key, confidence: r.confidence })), actions,
    model, usage, latency_ms: latency, first_token_ms: firstTokenMs, language,
  });
  const newState = decision.state;
  await store.updateConversation(conv.id, {
    state: newState, previousState: conv.state, language, profile, leadId,
    intents: Array.from(new Set([...(conv.intents ?? []), ...analysis.categories])),
    score: score?.score ?? conv.score, escalationStatus, incrementMessages: input.userMessageAlreadyStored ? 1 : 2, lastMessageAt: new Date(),
  });
  if (newState === "COMPLETED") void store.track("chat_completed", {}, conv.id);

  // 11) Post-turn evaluation (summary, unresolved questions, conflicts) — off the critical path.
  deps.background((async () => {
    try {
      const r = await llm.json({
        model: s.ai.analysisModel, system: EVALUATOR_SYSTEM, schema: evaluatorJsonSchema(), maxTokens: 600, timeoutMs: 20_000,
        messages: [{ role: "user", content: `<previous_summary>${conv.summary ?? "(none)"}</previous_summary>\n<visitor>${message}</visitor>\n<assistant_reply>${replyText}</assistant_reply>\n<sources_used>${chunks.map((c) => `${c.title} (${c.url ?? "internal"})`).join("; ") || "none"}</sources_used>` }],
      });
      void store.recordUsage(r.model, r.usage, 0);
      const ev = r.data as { answered: string; unanswered_question: string | null; conflict: string | null; summary: string };
      const patch: Partial<ConversationRecord> = { summary: (ev.summary ?? "").slice(0, 1200) || conv.summary };
      if ((ev.answered === "no" || ev.answered === "partial") && ev.unanswered_question && !security) {
        await store.addUnanswered(conv.id, ev.unanswered_question.slice(0, 500), language, ev.answered);
        patch.unresolvedCount = conv.unresolvedCount + 1;
        void store.track("answer_unresolved", { answered: ev.answered }, conv.id);
      }
      if (ev.conflict) await store.addConflict(conv.id, ev.conflict.slice(0, 500));
      await store.updateConversation(conv.id, patch);
    } catch (err) { log("evaluation_failed", { error: String(err).slice(0, 300) }); }
  })());

  emit({ type: "done", messageId: assistantMessageId, state: newState, language });
  return { assistantMessageId, state: newState };
}

function dedupeSources(chunks: RetrievedChunk[]) {
  const seen = new Set<string>();
  const out: { title: string; url: string }[] = [];
  for (const c of chunks) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({ title: c.title.split(" / ")[0].slice(0, 80), url: c.url });
  }
  return out;
}

export { FALLBACK_REPLY };
