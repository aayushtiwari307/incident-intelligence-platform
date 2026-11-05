import { ProviderError } from "../analysis/provider";
import { SUGGESTION_JSON_SCHEMA } from "./suggestion-prompt";
import type { SuggestionProvider, SuggestionProviderRequest, SuggestionProviderResponse } from "./suggestion-provider";

export interface GeminiSuggestionOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Constructor-only transport seam. The production Google API hostname is fixed and cannot be redirected by env. */
  fetchImpl?: typeof fetch;
}

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000_000 ? value : null;

function extractCandidateText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const first = candidates[0];
  if (typeof first !== "object" || first === null) return null;
  const candidate = first as { finishReason?: unknown; content?: unknown };
  // A safety-blocked, recitation-blocked, or otherwise incomplete candidate is not usable JSON.
  if (candidate.finishReason !== undefined && candidate.finishReason !== "STOP") return null;
  if (typeof candidate.content !== "object" || candidate.content === null) return null;
  const parts = (candidate.content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((part) => {
      if (typeof part !== "object" || part === null) return undefined;
      const textPart = part as { text?: unknown; thought?: unknown };
      return textPart.thought === true ? undefined : textPart.text;
    })
    .filter((part): part is string => typeof part === "string")
    .join("");
  return text.length > 0 ? text : null;
}

/** Gemini generateContent adapter for grounded suggestions. Raw output remains untrusted until the job handler validates it. */
export class GeminiSuggestionProvider implements SuggestionProvider {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GeminiSuggestionOptions) {
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async suggest(request: SuggestionProviderRequest): Promise<SuggestionProviderResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${GEMINI_MODELS_URL}/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.options.apiKey,
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: [{ text: request.user }] }],
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            responseMimeType: "application/json",
            responseJsonSchema: SUGGESTION_JSON_SCHEMA,
          },
        }),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderError("timeout", "provider request timed out", true);
      }
      throw new ProviderError("provider_error", "provider request failed", true);
    }

    // Never read an error response body: it can echo incident text or credentials.
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError("provider_error", `provider returned HTTP ${response.status}`, retryable);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderError("invalid_output", "provider response was not JSON", true);
    }

    const text = extractCandidateText(body);
    if (text === null) throw new ProviderError("invalid_output", "provider returned no usable output", true);

    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new ProviderError("invalid_output", "provider output was not valid JSON", true);
    }

    const usage = (body as { usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown } }).usageMetadata;
    return {
      output,
      usage: usage
        ? { inputTokens: asCount(usage.promptTokenCount), outputTokens: asCount(usage.candidatesTokenCount) }
        : null,
    };
  }
}
