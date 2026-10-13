import type { IncidentSeverity } from "@platform/shared";

/** What a provider is allowed to see: no emails, names, organization data or ids, only the incident's own words. */
export interface AnalysisInput {
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: string;
}

export class ProviderError extends Error {
  constructor(
    readonly kind: "provider_error" | "timeout" | "invalid_output",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Returns the model's RAW JSON output. It is deliberately `unknown`: the handler validates it against the strict
 * result schema, so no provider implementation can bypass validation.
 */
export interface AnalysisProvider {
  readonly model: string;
  analyze(input: AnalysisInput): Promise<unknown>;
}
