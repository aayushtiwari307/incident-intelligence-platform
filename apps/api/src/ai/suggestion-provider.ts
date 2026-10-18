import type { SuggestionContext } from "./suggestion-context";

/** What a provider receives: the fixed instructions, the (already redacted, bounded) sources, and a token ceiling. */
export interface SuggestionProviderRequest {
  promptVersion: string;
  system: string;
  /** The user message as sent over the wire (a JSON string). */
  user: string;
  /** The same sources in structured form. Real providers ignore this; the deterministic fake derives its answer from it. */
  context: SuggestionContext;
  maxOutputTokens: number;
}

export interface SuggestionProviderResponse {
  /** The model's RAW output. Deliberately `unknown`: the handler validates it, so no provider can bypass validation. */
  output: unknown;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
}

export interface SuggestionProvider {
  readonly model: string;
  suggest(request: SuggestionProviderRequest): Promise<SuggestionProviderResponse>;
}

const clip = (value: string, max: number): string => value.slice(0, max);

/**
 * A deterministic provider with no network and no key: it builds a VALID, grounded answer from the sources it was given
 * (quotes are copied from them). It is the only provider used by the automated tests and by `AI_PROVIDER=fake`, which
 * exists so the whole feature can be tried locally at zero cost and is refused in production.
 *
 * `script` lets tests return anything instead (invented ids, fabricated quotes, malformed output, ...) to prove that
 * validation rejects it. Every call is recorded in `requests`.
 */
export class FakeSuggestionProvider implements SuggestionProvider {
  readonly model = "fake-grounded-1";
  readonly requests: SuggestionProviderRequest[] = [];

  constructor(private readonly script: Array<(request: SuggestionProviderRequest) => unknown | Promise<unknown>> = []) {}

  async suggest(request: SuggestionProviderRequest): Promise<SuggestionProviderResponse> {
    this.requests.push(request);
    const next = this.script[this.requests.length - 1];
    const output = next ? await next(request) : FakeSuggestionProvider.grounded(request.context);
    return { output, usage: { inputTokens: Math.ceil(request.user.length / 4), outputTokens: 120 } };
  }

  /** A valid answer whose every quote is copied from the sources. */
  static grounded(context: SuggestionContext): unknown {
    const current = context.sources[0];
    const similar = context.sources.filter((s) => s.role === "similar");
    const quoteOf = (text: string) => clip(text, 80);
    const fixLine = (text: string) => text.split("\n").find((line) => line.startsWith("Fix applied: ")) ?? text.split("\n")[0] ?? text;
    return {
      summary: {
        text: similar.length > 0 ? `This looks similar to ${similar.length} earlier resolved incident(s).` : "No similar resolved incident was found; review the incident details.",
        citations: [{ source: "S0", quote: quoteOf(current?.text ?? "") }],
      },
      severity: similar[0]
        ? { value: context.incident.severity, rationale: "Keep the current severity unless the impact differs from the earlier incident.", citations: [{ source: similar[0].alias, quote: quoteOf(similar[0].text) }] }
        : null,
      nextSteps: similar.slice(0, 3).map((s) => ({
        text: `Review how ${s.alias} was handled and check whether it applies here.`,
        citations: [{ source: s.alias, quote: clip(fixLine(s.text), 120) }],
      })),
      relatedIncidents: similar.map((s) => ({ source: s.alias })),
    };
  }
}
