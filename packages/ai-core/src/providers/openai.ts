import OpenAI from "openai";
import type { EmbeddingProvider, JsonRequest, LLMMessage, LLMProvider, StreamRequest, StreamResult } from "./types";
import { ProviderUnavailableError } from "./types";

function toChat(system: string, messages: LLMMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [{ role: "system", content: system }, ...messages.map((m) => (m.role === "system" ? { role: "developer" as const, content: m.content } : { role: m.role, content: m.content }))];
}

/** OpenAI-compatible adapter (OpenAI via Netlify AI Gateway or own key). */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;
  constructor(opts: { apiKey?: string; baseURL?: string } = {}) {
    if (!opts.apiKey && !process.env.OPENAI_API_KEY) throw new ProviderUnavailableError("No OpenAI credentials.");
    this.client = new OpenAI({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), maxRetries: 2 });
  }
  async json(req: JsonRequest) {
    const res = await this.client.chat.completions.create({
      model: req.model, max_completion_tokens: req.maxTokens, messages: toChat(req.system, req.messages),
      response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: req.schema } },
    }, { timeout: req.timeoutMs ?? 20_000 });
    const u = res.usage;
    return { data: JSON.parse(res.choices[0]?.message?.content ?? "{}"), usage: { inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0, cachedInputTokens: 0 }, model: res.model };
  }
  async stream(req: StreamRequest, onText: (d: string) => void): Promise<StreamResult> {
    const stream = await this.client.chat.completions.create({
      model: req.model, max_completion_tokens: req.maxTokens, messages: toChat(req.system, req.messages), stream: true, stream_options: { include_usage: true },
    }, { timeout: req.timeoutMs ?? 50_000 });
    let text = ""; let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }; let stop: string | null = null; let model = req.model;
    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta?.content;
      if (d) { text += d; onText(d); }
      if (chunk.choices[0]?.finish_reason) stop = chunk.choices[0].finish_reason;
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, cachedInputTokens: 0 };
      model = chunk.model ?? model;
    }
    return { text, usage, stopReason: stop, model };
  }
}

/** OpenAI embeddings (text-embedding-3-small, 1536 dims) — optional hybrid retrieval. */
export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly model = "text-embedding-3-small";
  readonly dimensions = 1536;
  private client: OpenAI;
  constructor(apiKey: string, baseURL?: string) { this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) }); }
  async embed(texts: string[]) {
    const res = await this.client.embeddings.create({ model: this.model, input: texts });
    return res.data.map((d) => d.embedding);
  }
}
