"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AiApplyTarget, AiCitationDto, AiDraftDto, AiSuggestionDto, AiSuggestionStateDto, AiUnavailableReason, IncidentDto } from "@platform/shared";
import { ApiError } from "../lib/api-client";
import { SEVERITY_LABEL, errorText, relativeTime } from "../lib/format";
import { api } from "../lib/session";
import { useCan } from "./shell";

const POLL_MS = 2500;

export const UNAVAILABLE_TEXT: Record<AiUnavailableReason, string> = {
  server_disabled: "AI suggestions are not enabled on this server.",
  org_not_opted_in: "AI suggestions are turned off for your organization. An owner or admin can turn them on in Team settings.",
  quota_exhausted: "Your organization has used today's AI suggestion allowance. It resets at 00:00 UTC.",
};

const FAILURE_TEXT: Record<string, string> = {
  provider_error: "the AI provider returned an error",
  invalid_output: "the answer did not pass the safety checks, so it was discarded",
  timeout: "the AI provider took too long",
  incident_missing: "the incident is no longer available",
  gate_closed: "AI suggestions were switched off before it could run",
};

function Citations({ citations, sources }: { citations: AiCitationDto[]; sources: AiSuggestionDto["sources"] }) {
  if (citations.length === 0) return null;
  return (
    <ul className="plain muted" aria-label="Sources">
      {citations.map((c, i) => {
        const source = sources[c.incidentId];
        return (
          <li key={i}>
            {source ? (
              <Link href={`/incidents/${encodeURIComponent(c.incidentId)}`}>
                #{source.number} {source.title}
              </Link>
            ) : (
              <span>Incident no longer available</span>
            )}
            : <q className="prewrap">{c.quote}</q>
          </li>
        );
      })}
    </ul>
  );
}

function SuggestionBody({ s, incident, canUse, busy, onApply, onDismiss }: {
  s: AiSuggestionDto;
  incident: Pick<IncidentDto, "version" | "severity">;
  canUse: boolean;
  busy: boolean;
  onApply(target: AiApplyTarget): void;
  onDismiss(): void;
}) {
  const content = s.content;
  if (s.status === "queued" || s.status === "running") return <p role="status">{s.status === "queued" ? "Queued…" : "Generating a suggestion…"}</p>;
  if (s.status === "failed") {
    return (
      <p role="status">
        No suggestion could be produced: {FAILURE_TEXT[s.errorCode ?? ""] ?? "an unexpected problem occurred"}. Nothing was changed. You can try again.
      </p>
    );
  }
  if (!content) return null;
  const reviewable = s.status === "pending" || s.status === "applied";
  return (
    <div data-testid="ai-suggestion">
      <p className="muted">
        <strong>AI-generated, verify before use.</strong> Quotes show where the text came from; they do not prove the claim is true.
        {s.status === "applied" ? " Draft created (nothing was saved to the incident)." : ""}
        {s.status === "dismissed" ? " Dismissed." : ""}
      </p>
      {s.incidentVersion < incident.version ? <p className="muted">The incident changed after this was generated. Generate a new suggestion to refresh.</p> : null}
      <h3>Summary</h3>
      <p className="prewrap">{content.summary.text}</p>
      <Citations citations={content.summary.citations} sources={s.sources} />
      {content.severity ? (
        <>
          <h3>Suggested severity: {SEVERITY_LABEL[content.severity.value]}</h3>
          <p className="prewrap">{content.severity.rationale}</p>
          <Citations citations={content.severity.citations} sources={s.sources} />
        </>
      ) : null}
      <h3>Suggested next steps</h3>
      {content.nextSteps.length === 0 ? (
        <p className="muted">No grounded next steps were found.</p>
      ) : (
        <ol>
          {content.nextSteps.map((step, i) => (
            <li key={i}>
              <span className="prewrap">{step.text}</span>
              <Citations citations={step.citations} sources={s.sources} />
            </li>
          ))}
        </ol>
      )}
      {content.relatedIncidents.length > 0 ? (
        <>
          <h3>Related incidents</h3>
          <ul className="plain">
            {content.relatedIncidents.map((r) => {
              const source = s.sources[r.incidentId];
              return (
                <li key={r.incidentId}>
                  {source ? (
                    <Link href={`/incidents/${encodeURIComponent(r.incidentId)}`}>
                      #{source.number} {source.title}
                    </Link>
                  ) : (
                    "Incident no longer available"
                  )}
                  : <span className="prewrap">{r.reason}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {canUse && reviewable ? (
        <div className="actions">
          {content.severity && content.severity.value !== incident.severity ? (
            <button type="button" className="btn secondary" disabled={busy} onClick={() => onApply("severity")}>
              Use severity as draft
            </button>
          ) : null}
          {content.nextSteps.length > 0 ? (
            <button type="button" className="btn secondary" disabled={busy} onClick={() => onApply("comment")}>
              Use next steps as comment draft
            </button>
          ) : null}
          {s.status === "pending" ? (
            <button type="button" className="btn secondary" disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="muted">
        Model {s.model ?? "unknown"} · {relativeTime(s.createdAt)}
      </p>
    </div>
  );
}

/** Presentational: everything it shows comes from props, so it can be rendered and tested without a server. */
export function AiSuggestionsView({ state, incident, canUse, busy, error, onRequest, onApply, onDismiss }: {
  state: AiSuggestionStateDto | null;
  incident: Pick<IncidentDto, "version" | "severity">;
  canUse: boolean;
  busy: boolean;
  error: string | null;
  onRequest(): void;
  onApply(suggestion: AiSuggestionDto, target: AiApplyTarget): void;
  onDismiss(suggestion: AiSuggestionDto): void;
}) {
  const items = state?.items ?? [];
  const inFlight = items.some((item) => item.status === "queued" || item.status === "running");
  const settings = state?.settings;
  return (
    <section aria-labelledby="ai-sug-h" className="card">
      <h2 id="ai-sug-h" style={{ marginTop: 0 }}>
        AI suggestions <span className="badge">Draft only</span>
      </h2>
      <div role="alert" className="form-error">
        {error}
      </div>
      {!state ? <p role="status">Loading…</p> : null}
      {settings && !settings.canGenerate && settings.unavailableReason ? <p className="muted">{UNAVAILABLE_TEXT[settings.unavailableReason]}</p> : null}
      {settings?.serverEnabled && settings.organizationOptIn ? (
        <p className="muted">
          {settings.remainingToday} of {settings.dailyLimit} organization requests left today. The incident text sent to the AI provider is redacted on a best-effort basis.
        </p>
      ) : null}
      {items.length > 0 ? (
        <div className="ai-suggestions-history">
          {items.map((item) => (
            <div className="ai-suggestion-history-item" key={item.id}>
              <SuggestionBody
                s={item}
                incident={incident}
                canUse={canUse}
                busy={busy}
                onApply={(target) => onApply(item, target)}
                onDismiss={() => onDismiss(item)}
              />
            </div>
          ))}
        </div>
      ) : null}
      {state && items.length === 0 && settings?.canGenerate ? <p className="muted">No suggestion yet.</p> : null}
      {canUse && settings?.canGenerate && !inFlight ? (
        <button type="button" className="btn secondary" disabled={busy} onClick={onRequest}>
          {items.length > 0 ? "Generate a new suggestion" : "Suggest with AI"}
        </button>
      ) : null}
    </section>
  );
}

export interface AiDraftRequest {
  severity: IncidentDto["severity"] | null;
  commentBody: string | null;
}

export function AiSuggestionsPanel({ incident, onDraft }: { incident: IncidentDto; onDraft(draft: AiDraftRequest): void }) {
  const canUse = useCan("aiSuggestion:use");
  const [state, setState] = useState<AiSuggestionStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.aiSuggestionState(incident.id));
    } catch (e) {
      setError(errorText(e));
    }
  }, [incident.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const status = state?.items[0]?.status;
  useEffect(() => {
    if (status !== "queued" && status !== "running") return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [status, load]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "That suggestion is already being handled." : errorText(e));
      await load();
    }
    setBusy(false);
  }

  return (
    <AiSuggestionsView
      state={state}
      incident={incident}
      canUse={canUse}
      busy={busy}
      error={error}
      onRequest={() => void run(async () => setState(await api.requestAiSuggestion(incident.id)))}
      onApply={(s, target) =>
        void run(async () => {
          const draft: AiDraftDto = await api.applyAiSuggestion(incident.id, s.id, target);
          onDraft({ severity: draft.severity, commentBody: draft.commentBody });
          await load();
        })
      }
      onDismiss={(s) => void run(async () => { await api.dismissAiSuggestion(incident.id, s.id); await load(); })}
    />
  );
}
