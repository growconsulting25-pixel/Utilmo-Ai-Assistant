export const INTEREST_CATEGORIES = [
  "LEAD_GENERATION", "CRM", "WEBSITE", "AUTOMATION", "MARKETING", "BRANDING",
  "AI_ASSISTANT", "CUSTOMER_SUPPORT", "GENERAL_INFORMATION", "OTHER",
] as const;
export type InterestCategory = (typeof INTEREST_CATEGORIES)[number];

export const CONVERSATION_STATES = [
  "GREETING", "GENERAL_INFORMATION", "NEEDS_DISCOVERY", "SERVICE_RECOMMENDATION", "CONTACT_CAPTURE",
  "LEAD_QUALIFICATION", "BOOKING", "EXISTING_CUSTOMER_SUPPORT", "SUPPORT_ESCALATION", "COMPLETED", "HUMAN_HANDOFF",
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const INTENTS = [
  "GREETING", "PRODUCT_QUESTION", "PRICING_QUESTION", "INTEGRATION_QUESTION", "NEED_STATEMENT", "PROVIDE_INFO",
  "CONTACT_INFO", "BOOKING_REQUEST", "SUPPORT_REQUEST", "HUMAN_REQUEST", "REFUSE_CONTACT", "SMALL_TALK",
  "OFF_TOPIC", "PROMPT_INJECTION", "SENSITIVE_REQUEST", "GOODBYE", "OTHER",
] as const;
export type Intent = (typeof INTENTS)[number];

export const ANALYTICS_EVENTS = [
  "chat_opened", "chat_started", "message_sent", "intent_detected", "service_recommended", "contact_captured",
  "lead_qualified", "lead_synced", "booking_clicked", "booking_confirmed", "support_requested", "support_escalated",
  "answer_unresolved", "chat_completed",
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** Events a public widget is allowed to report directly (everything else is server-generated). */
export const CLIENT_EVENTS = ["chat_opened", "booking_clicked"] as const;

export const SUPPORT_CATEGORIES = ["account_access", "contacts", "pipeline", "import", "automation", "website", "billing", "technical", "other"] as const;

export type Lang = "fr" | "en";
