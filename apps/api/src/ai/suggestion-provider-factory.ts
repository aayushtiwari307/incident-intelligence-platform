import type { AiConfig } from "../config/env";
import { OpenAiSuggestionProvider } from "./openai-suggestion-provider";
import { GeminiSuggestionProvider } from "./gemini-suggestion-provider";
import { FakeSuggestionProvider, type SuggestionProvider } from "./suggestion-provider";

export interface SuggestionProviderFactoryOptions {
  /** Test seam for deterministic transport. Production adapters keep their provider host fixed in source code. */
  fetchImpl?: typeof fetch;
}

/**
 * The provider for grounded suggestions, or null when they are off. Null is the answer for AI_ENABLED=false,
 * a missing key, or AI_PROVIDER=none, so with the default configuration no provider object exists.
 */
export function createSuggestionProvider(ai: AiConfig, options: SuggestionProviderFactoryOptions = {}): SuggestionProvider | null {
  if (!ai.suggestions.enabled) return null;
  if (ai.provider === "fake") return new FakeSuggestionProvider();
  if (ai.provider === "openai" && ai.apiKey) {
    return new OpenAiSuggestionProvider({
      apiKey: ai.apiKey.reveal(),
      model: ai.model,
      timeoutMs: ai.timeoutMs,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  if (ai.provider === "gemini" && ai.apiKey) {
    return new GeminiSuggestionProvider({
      apiKey: ai.apiKey.reveal(),
      model: ai.model,
      timeoutMs: ai.timeoutMs,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  return null;
}
