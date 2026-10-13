import { ProviderError, type AnalysisInput, type AnalysisProvider } from "./provider";
import { RESULT_JSON_SCHEMA, SYSTEM_PROMPT, buildUserMessage } from "./prompt";

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /**
   * Constructor-only on purpose: it is NOT an environment variable, so a configuration mistake or injection cannot
   * redirect the API key to another host. Tests point it at a local fake server.
   */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** OpenAI Responses API with strict structured output, over plain `fetch` (no SDK dependency). */
export class OpenAiAnalysisProvider implements AnalysisProvider {
  readonly model: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiOptions) {
    this.model = options.model;
    this.base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async analyze(input: AnalysisInput): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
        signal: AbortSignal.timeout(this.options.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          store: false, // do not retain incident text in the provider's stored responses
          input: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserMessage(input) },
          ],
          text: { format: { type: "json_schema", name: "incident_analysis", strict: true, schema: RESULT_JSON_SCHEMA } },
        }),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ProviderError("timeout", "provider request timed out", true);
      throw new ProviderError("provider_error", "provider request failed", true);
    }

    if (!response.ok) {
      // Never surface or store the response body: it can echo request content. Status only.
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
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("invalid_output", "provider output was not valid JSON", true);
    }
  }
}

/** First `output_text` of the first message in a Responses API body; null for refusals, incomplete or odd shapes. */
export function extractOutputText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { status, output } = body as { status?: unknown; output?: unknown };
  if (status !== undefined && status !== "completed") return null;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (typeof item !== "object" || item === null || (item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === "output_text" && typeof p.text === "string") return p.text;
    }
  }
  return null;
}
