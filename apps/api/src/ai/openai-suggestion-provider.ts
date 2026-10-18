import { ProviderError } from "../analysis/provider";
import { extractOutputText } from "../analysis/openai-provider";
import { SUGGESTION_JSON_SCHEMA } from "./suggestion-prompt";
import type { SuggestionProvider, SuggestionProviderRequest, SuggestionProviderResponse } from "./suggestion-provider";

export interface OpenAiSuggestionOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Constructor-only on purpose (see OpenAiAnalysisProvider): NOT an environment variable, so a configuration mistake cannot redirect the key. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const asCount = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000_000 ? value : null);

/**
 * OpenAI Responses API with strict structured output over plain `fetch`, reusing the M2 transport rules: `store: false`,
 * a hard timeout, status-only errors (a response body can echo the request, so it is never read into an error), and raw
 * output returned unvalidated. NOT verified against the live API (no key is used in this project's checks).
 */
export class OpenAiSuggestionProvider implements SuggestionProvider {
  readonly model: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiSuggestionOptions) {
    this.model = options.model;
    this.base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async suggest(request: SuggestionProviderRequest): Promise<SuggestionProviderResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
        signal: AbortSignal.timeout(this.options.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          store: false, // do not retain incident text in the provider's stored responses
          max_output_tokens: request.maxOutputTokens,
          input: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          text: { format: { type: "json_schema", name: "grounded_incident_suggestion", strict: true, schema: SUGGESTION_JSON_SCHEMA } },
        }),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ProviderError("timeout", "provider request timed out", true);
      throw new ProviderError("provider_error", "provider request failed", true);
    }

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
    const text = extractOutputText(body);
    if (text === null) throw new ProviderError("invalid_output", "provider returned no usable output", true);
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new ProviderError("invalid_output", "provider output was not valid JSON", true);
    }
    const usage = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
    return { output, usage: usage ? { inputTokens: asCount(usage.input_tokens), outputTokens: asCount(usage.output_tokens) } : null };
  }
}
