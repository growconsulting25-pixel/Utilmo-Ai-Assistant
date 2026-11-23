import type { JsonRequest, LLMProvider, StreamRequest, StreamResult } from "./types";

/**
 * TEST DOUBLE ONLY. Deterministic provider used by automated tests and local UI development when no
 * real model is reachable. It is refused in production (see server/ai.ts) and every reply it produces
 * is prefixed so it can never be mistaken for live AI output.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = "scripted-test-double";
  constructor(private handlers: {
    json?: (req: JsonRequest) => unknown;
    reply?: (req: StreamRequest) => string;
  } = {}) {}
  async json(req: JsonRequest) {
    if (!this.handlers.json) throw new Error("scripted provider has no json handler");
    return { data: this.handlers.json(req), usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, model: "scripted" };
  }
  async stream(req: StreamRequest, onText: (d: string) => void): Promise<StreamResult> {
    const text = this.handlers.reply ? this.handlers.reply(req) : "[TEST DOUBLE] Réponse simulée.";
    for (const part of text.match(/.{1,12}/gs) ?? []) onText(part);
    return { text, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, stopReason: "end_turn", model: "scripted" };
  }
}
