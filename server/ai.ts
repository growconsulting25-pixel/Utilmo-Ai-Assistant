import { AnthropicProvider } from "../packages/ai-core/src/providers/anthropic";
import { OpenAIEmbeddings, OpenAIProvider } from "../packages/ai-core/src/providers/openai";
import type { EmbeddingProvider, LLMProvider } from "../packages/ai-core/src/providers/types";
import type { AssistantSettings } from "../packages/shared/src/settings";
import { env, isDevMode } from "./env";

let override: LLMProvider | null = null;
/** Tests / local UI development only. */
export function setLLMOverride(p: LLMProvider | null) {
  if (p && !isDevMode()) throw new Error("LLM overrides are not allowed in production");
  override = p;
}

/**
 * Provider selection: AI_PROVIDER env (or assistant setting) chooses the adapter.
 * Credentials: AI_API_KEY if set, otherwise the Netlify AI Gateway-injected provider variables.
 */
export function getLLM(s: AssistantSettings): LLMProvider {
  if (override) return override;
  const provider = (env("AI_PROVIDER") as "anthropic" | "openai" | undefined) ?? s.ai.provider;
  const apiKey = env("AI_API_KEY");
  const baseURL = env("AI_BASE_URL");
  return provider === "openai" ? new OpenAIProvider({ apiKey, baseURL }) : new AnthropicProvider({ apiKey, baseURL });
}

/** Model ids: env overrides (AI_MODEL / AI_ANALYSIS_MODEL) take precedence over per-assistant settings. */
export function effectiveSettings(s: AssistantSettings): AssistantSettings {
  const m = env("AI_MODEL"), am = env("AI_ANALYSIS_MODEL");
  return { ...s, ai: { ...s.ai, responseModel: m ?? s.ai.responseModel, analysisModel: am ?? s.ai.analysisModel } };
}

/** Optional embeddings for hybrid retrieval (EMBEDDING_PROVIDER=openai + EMBEDDING_API_KEY). */
export function getEmbedder(): EmbeddingProvider | null {
  const p = env("EMBEDDING_PROVIDER");
  const key = env("EMBEDDING_API_KEY");
  if (p === "openai" && key) return new OpenAIEmbeddings(key, env("EMBEDDING_BASE_URL"));
  return null;
}
