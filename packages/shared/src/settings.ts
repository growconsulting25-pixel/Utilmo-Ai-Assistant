import { z } from "zod";

/** Bilingual string. French is the default language of the platform. */
export const I18n = z.object({ fr: z.string().default(""), en: z.string().default("") });
export type I18nText = z.infer<typeof I18n>;
const I18nList = z.object({ fr: z.array(z.string()).default([]), en: z.array(z.string()).default([]) });

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const QUALIFICATION_FIELDS = [
  "first_name", "last_name", "email", "phone", "brokerage", "city", "territory", "user_type",
  "existing_customer", "main_goal", "services_interest", "current_crm", "website_status",
  "lead_methods", "biggest_challenge", "lead_volume", "automation_needs", "timeline",
  "budget_range", "demo_interest",
] as const;

export const SettingsSchema = z.object({
  behavior: z.object({
    assistantName: z.string().min(1).max(60).default("Assistant"),
    companyName: z.string().default("Company"),
    defaultLanguage: z.enum(["fr", "en"]).default("fr"),
    tone: z.enum(["friendly_professional", "formal", "casual"]).default("friendly_professional"),
    companyDescription: I18n.default({ fr: "", en: "" }),
    welcome: I18n.default({ fr: "Bonjour 👋 Comment puis-je vous aider ?", en: "Hi 👋 How can I help?" }),
    suggestions: I18nList.default({ fr: [], en: [] }),
    maxResponseWords: z.number().int().min(40).max(400).default(130),
    /** Fields the assistant may collect, in preferred order. */
    qualificationFields: z.array(z.enum(QUALIFICATION_FIELDS)).default([...QUALIFICATION_FIELDS]),
    /** Budget is only asked when explicitly enabled. */
    askBudget: z.boolean().default(false),
    /** After this many substantive exchanges, contact capture may be proposed (never forced). */
    contactCaptureAfterTurns: z.number().int().min(1).max(20).default(3),
    escalation: z.object({
      unresolvedThreshold: z.number().int().min(1).max(10).default(2),
      supportEmail: z.string().default(""),
      supportPhone: z.string().default(""),
      salesPhone: z.string().default(""),
    }).prefault({}),
    extraInstructions: z.string().max(4000).default(""),
  }).prefault({}),
  ai: z.object({
    provider: z.enum(["anthropic", "openai"]).default("anthropic"),
    responseModel: z.string().default("claude-opus-5-5"),
    analysisModel: z.string().default("claude-haiku-5-5"),
    effort: z.enum(["low", "medium", "high"]).default("low"),
    maxOutputTokens: z.number().int().min(256).max(8000).default(1500),
    retrievalTopK: z.number().int().min(2).max(12).default(6),
    embeddings: z.enum(["none", "openai"]).default("none"),
  }).prefault({}),
  booking: z.object({
    provider: z.enum(["none", "link", "calendly", "cal_com"]).default("none"),
    url: z.string().default(""),
    label: I18n.default({ fr: "Réserver une démo", en: "Book a demo" }),
  }).prefault({}),
  appearance: z.object({
    primaryColor: hex.default("#4c2b7b"),
    accentColor: hex.default("#f47421"),
    backgroundColor: hex.default("#ffffff"),
    textColor: hex.default("#1d2124"),
    radius: z.number().int().min(0).max(32).default(20),
    fontFamily: z.string().default("Montserrat"),
    headingFontFamily: z.string().default("Poppins"),
    loadGoogleFonts: z.boolean().default(true),
    logoUrl: z.string().default(""),
    avatarUrl: z.string().default(""),
    launcherPosition: z.enum(["right", "left"]).default("right"),
    launcherStyle: z.enum(["circle", "pill"]).default("circle"),
    launcherLabel: I18n.default({ fr: "Discuter", en: "Chat" }),
    attentionAnimation: z.boolean().default(true),
    teaser: z.object({
      enabled: z.boolean().default(true),
      delaySeconds: z.number().int().min(0).max(120).default(6),
      text: I18n.default({ fr: "Une question ? Je peux vous aider.", en: "Questions? I can help." }),
    }).prefault({}),
    inlineHeight: z.number().int().min(360).max(1000).default(600),
    mobileFullscreen: z.boolean().default(true),
  }).prefault({}),
  privacy: z.object({
    noticeVersion: z.string().default("2026-11-23"),
    notice: I18n.default({ fr: "", en: "" }),
    privacyPolicyUrl: I18n.default({ fr: "", en: "" }),
    conversationRetentionDays: z.number().int().min(7).max(3650).default(365),
    sessionRetentionDays: z.number().int().min(1).max(365).default(30),
  }).prefault({}),
  limits: z.object({
    messagesPerMinute: z.number().int().min(1).max(60).default(8),
    messagesPerConversation: z.number().int().min(5).max(500).default(80),
    dailyMessageCap: z.number().int().min(10).max(1_000_000).default(3000),
    maxMessageChars: z.number().int().min(100).max(8000).default(2000),
  }).prefault({}),
  scoring: z.object({
    weights: z.object({
      intent: z.number().min(0).max(100).default(25),
      need: z.number().min(0).max(100).default(20),
      timeline: z.number().min(0).max(100).default(15),
      contact: z.number().min(0).max(100).default(15),
      fit: z.number().min(0).max(100).default(15),
      readiness: z.number().min(0).max(100).default(10),
    }).prefault({}),
    thresholds: z.object({ medium: z.number().default(40), high: z.number().default(70) }).prefault({}),
    qualifiedMinScore: z.number().default(55),
  }).prefault({}),
  seedVersionApplied: z.number().int().default(0),
});

export type AssistantSettings = z.infer<typeof SettingsSchema>;

/** Parse stored JSON into fully-defaulted settings (tolerant of partial objects). */
export function parseSettings(raw: unknown): AssistantSettings {
  return SettingsSchema.parse(raw ?? {});
}

/** Public subset safe to expose to the widget (no models, limits internals or instructions). */
export function publicSettings(s: AssistantSettings) {
  return {
    assistantName: s.behavior.assistantName,
    companyName: s.behavior.companyName,
    defaultLanguage: s.behavior.defaultLanguage,
    welcome: s.behavior.welcome,
    suggestions: s.behavior.suggestions,
    booking: { enabled: s.booking.provider !== "none" && !!s.booking.url, url: s.booking.url, label: s.booking.label },
    appearance: s.appearance,
    privacy: { notice: s.privacy.notice, privacyPolicyUrl: s.privacy.privacyPolicyUrl, noticeVersion: s.privacy.noticeVersion, sessionRetentionDays: s.privacy.sessionRetentionDays },
    maxMessageChars: s.limits.maxMessageChars,
  };
}
export type PublicSettings = ReturnType<typeof publicSettings>;
