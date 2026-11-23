import Anthropic from "@anthropic-ai/sdk";
import type { JsonRequest, LLMMessage, LLMProvider, LLMUsage, StreamRequest, StreamResult } from "./types";
import { ProviderUnavailableError } from "./types";

function toParams(messages: LLMMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }) as Anthropic.MessageParam);
}
function usageOf(u: Anthropic.Usage | undefined | null): LLMUsage {
  return { inputTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0), outputTokens: u?.output_tokens ?? 0, cachedInputTokens: u?.cache_read_input_tokens ?? 0 };
}

/**
 * Anthropic adapter. On Netlify, AI Gateway injects ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL at runtime,
 * so `new Anthropic()` needs no configuration. A user-provided key (AI_API_KEY) takes precedence.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  constructor(opts: { apiKey?: string; baseURL?: string } = {}) {
    if (!opts.apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new ProviderUnavailableError("No Anthropic credentials: deploy on Netlify with AI Gateway enabled, or set AI_API_KEY.");
    }
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), maxRetries: 2 });
  }

  async json(req: JsonRequest) {
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: toParams(req.messages),
      output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
    }, { timeout: req.timeoutMs ?? 20_000 });
    if (res.stop_reason === "refusal") throw new Error("analysis_refused");
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return { data: JSON.parse(text), usage: usageOf(res.usage), model: res.model };
  }

  async stream(req: StreamRequest, onText: (d: string) => void): Promise<StreamResult> {
    const stream = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: toParams(req.messages),
      output_config: { effort: req.effort ?? "low" },
    }, { timeout: req.timeoutMs ?? 50_000 });
    let text = "";
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        text += ev.delta.text;
        onText(ev.delta.text);
      }
    }
    const final = await stream.finalMessage();
    return { text, usage: usageOf(final.usage), stopReason: final.stop_reason ?? null, model: final.model };
  }
}
