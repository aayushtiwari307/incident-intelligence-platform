"use client";

import { useState, type FormEvent } from "react";
import { ApiError } from "../lib/api-client";
import { errorText } from "../lib/format";
import { resolveIncidentFlow } from "../lib/incident-resolution-flow";
import { api } from "../lib/session";
import { Field, FormError } from "./ui";

export function ResolveForm({
  incidentId,
  expectedVersion,
  onCancel,
  onComplete,
  onTransitionFailure,
}: {
  incidentId: string;
  expectedVersion: number;
  onCancel(): void;
  onComplete(): void;
  onTransitionFailure(error: unknown): Promise<void>;
}) {
  const [rootCause, setRootCause] = useState("");
  const [fixApplied, setFixApplied] = useState("");
  const [resolutionSaved, setResolutionSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await resolveIncidentFlow(api, {
      incidentId,
      expectedVersion,
      rootCause,
      fixApplied,
      resolutionSaved,
    });
    if (result.status === "invalid") {
      setError(result.message);
      setBusy(false);
      return;
    }
    if (result.status === "completed") {
      onComplete();
      return;
    }

    if (result.stage === "resolution") {
      setError(
        result.resolutionConflict
          ? "A different resolution is already saved. Your entered text is retained and the incident status was not changed. Clear both fields to resolve without adding another resolution."
          : result.outcomeUnknown
            ? "We could not confirm whether your resolution details were saved. Your entries are retained; retry to reconcile the saved details before changing incident status."
            : errorText(result.error),
      );
    } else {
      setResolutionSaved(result.resolutionSaved);
      await onTransitionFailure(result.error);
      const reason =
        result.error instanceof ApiError && (result.error.code === "VERSION_CONFLICT" || result.error.code === "INVALID_TRANSITION")
          ? "The incident changed before it could be resolved. The latest incident has been reloaded; review it and retry."
          : errorText(result.error);
      setError(
        result.resolutionSaved
          ? `Resolution details were saved, but the status is still not resolved. ${reason} Your entries are retained; retrying will not create a duplicate resolution.`
          : reason,
      );
    }
    setBusy(false);
  }

  return (
    <form className="card" aria-label="Resolve incident" onSubmit={submit}>
      <p id="resolution-help" className="muted">
        Resolution details are optional. Leave both blank to resolve without them; if you enter one, enter both. Each field
        allows up to 2,000 characters.
      </p>
      <FormError message={error} />
      {resolutionSaved ? (
        <p role="status" className="notice">
          Resolution details are saved. Retry to complete the status change.
        </p>
      ) : null}
      <Field label="Root cause" htmlFor="resolution-root-cause">
        <textarea
          id="resolution-root-cause"
          name="rootCause"
          rows={3}
          maxLength={2000}
          readOnly={resolutionSaved}
          aria-describedby="resolution-help"
          value={rootCause}
          onChange={(event) => setRootCause(event.currentTarget.value)}
        />
      </Field>
      <Field label="Fix applied" htmlFor="resolution-fix-applied">
        <textarea
          id="resolution-fix-applied"
          name="fixApplied"
          rows={3}
          maxLength={2000}
          readOnly={resolutionSaved}
          aria-describedby="resolution-help"
          value={fixApplied}
          onChange={(event) => setFixApplied(event.currentTarget.value)}
        />
      </Field>
      <div className="actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Resolving…" : resolutionSaved ? "Retry resolve" : "Resolve incident"}
        </button>
        <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
