import { z } from "zod";

/** Request body for POST /api/chat */
export const ChatRequestSchema = z.object({
  assistantId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i),
  sessionToken: z.string().max(600).optional().nullable(),
  message: z.string().min(1).max(8000),
  clientMessageId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  language: z.enum(["fr", "en"]).optional(),
  surface: z.enum(["inline", "floating", "api"]).default("inline"),
  page: z.object({ url: z.string().max(2000).optional(), title: z.string().max(300).optional() }).optional(),
  firstTouch: z.object({
    utm_source: z.string().max(120).optional(), utm_medium: z.string().max(120).optional(),
    utm_campaign: z.string().max(200).optional(), utm_term: z.string().max(200).optional(),
    utm_content: z.string().max(200).optional(), referrer: z.string().max(300).optional(),
    landing: z.string().max(500).optional(),
  }).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export type ChatAction =
  | { type: "booking"; url: string; label: string }
  | { type: "suggestions"; items: string[] }
  | { type: "sources"; items: { title: string; url: string }[] }
  | { type: "contact_saved" }
  | { type: "ticket_created"; reference: string }
  | { type: "handoff"; phone?: string; email?: string };

/** NDJSON stream events returned by POST /api/chat */
export type ChatStreamEvent =
  | { type: "session"; sessionToken: string; conversationId: string }
  | { type: "status"; status: "thinking" | "writing" }
  | { type: "delta"; text: string }
  | { type: "replace"; text: string }
  | { type: "actions"; actions: ChatAction[] }
  | { type: "done"; messageId: string; state: string; language: "fr" | "en" }
  | { type: "error"; code: string; message: string; retryable: boolean };

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "agent";
  agentName?: string;
  content: string;
  actions?: ChatAction[];
  createdAt: string;
  clientMessageId?: string;
}

export const ClientEventSchema = z.object({
  assistantId: z.string().min(1).max(64),
  sessionToken: z.string().max(600).optional().nullable(),
  event: z.enum(["chat_opened", "booking_clicked"]),
  properties: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean()])).optional(),
});
