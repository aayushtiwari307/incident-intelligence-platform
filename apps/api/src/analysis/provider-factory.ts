import type { AiConfig } from "../config/env";
import { OpenAiAnalysisProvider } from "./openai-provider";
import type { AnalysisProvider } from "./provider";

export interface AnalysisProviderFactoryOptions {
  /** Test seam for deterministic provider transport. Production wiring always uses the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Returns the configured provider, or null when AI is off. The production OpenAI URL is fixed by
 * OpenAiAnalysisProvider; this injectable transport exists so E2E tests can route calls to a local mock
 * without adding a production environment variable capable of redirecting API credentials.
 */
export function createAnalysisProvider(ai: AiConfig, options: AnalysisProviderFactoryOptions = {}): AnalysisProvider | null {
  if (!ai.enabled || !ai.apiKey) return null;
  if (ai.provider === "openai") {
    return new OpenAiAnalysisProvider({
      apiKey: ai.apiKey.reveal(),
      model: ai.model,
      timeoutMs: ai.timeoutMs,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  return null;
}
