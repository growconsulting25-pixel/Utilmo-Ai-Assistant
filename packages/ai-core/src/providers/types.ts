export interface LLMMessage { role: "user" | "assistant" | "system"; content: string }
export interface LLMUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number }

export interface JsonRequest { model: string; system: string; messages: LLMMessage[]; schema: Record<string, unknown>; maxTokens: number; timeoutMs?: number }
export interface StreamRequest { model: string; system: string; messages: LLMMessage[]; maxTokens: number; effort?: "low" | "medium" | "high"; timeoutMs?: number }

export interface StreamResult { text: string; usage: LLMUsage; stopReason: string | null; model: string }

/** Provider-neutral interface; swap providers without touching orchestration code. */
export interface LLMProvider {
  readonly name: string;
  json(req: JsonRequest): Promise<{ data: unknown; usage: LLMUsage; model: string }>;
  stream(req: StreamRequest, onText: (delta: string) => void): Promise<StreamResult>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderUnavailableError"; }
}

/** Approximate list prices (USD / 1M tokens) for cost estimates shown in the admin dashboard. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-fable-5-2": { input: 8, output: 40 },
};
export function estimateCostUsd(model: string, u: LLMUsage): number {
  const p = MODEL_PRICING[model] ?? { input: 3, output: 15 };
  return (u.inputTokens * p.input + u.outputTokens * p.output) / 1_000_000;
}
