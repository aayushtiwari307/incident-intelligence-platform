"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { SimilarIncidentDto, SimilarIncidentsDto } from "@platform/shared";
import { api } from "../lib/session";
import { SEVERITY_LABEL, errorText, relativeTime } from "../lib/format";
import { SeverityBadge } from "./ui";

type SimilarState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; results: SimilarIncidentDto[] };

export function SimilarIncidentsContent({
  state,
  onRetry,
}: {
  state: SimilarState;
  onRetry(): void;
}) {
  return (
    <section className="card" aria-labelledby="similar-incidents-heading">
      <h2 id="similar-incidents-heading" style={{ marginTop: 0 }}>
        Similar incidents
      </h2>
      {state.status === "loading" ? <p role="status">Finding similar incidents…</p> : null}
      {state.status === "error" ? (
        <div>
          <p role="alert" className="form-error">{state.message}</p>
          <button type="button" className="btn secondary" onClick={onRetry}>
            Retry loading similar incidents
          </button>
        </div>
      ) : null}
      {state.status === "loaded" && state.results.length === 0 ? (
        <p className="muted">No similar resolved incidents found.</p>
      ) : null}
      {state.status === "loaded" && state.results.length > 0 ? (
        <ol className="plain">
          {state.results.slice(0, 5).map((result) => (
            <li key={result.id} className="card">
              <div className="page-head">
                <h3 style={{ margin: 0 }}>
                  <Link href={`/incidents/${encodeURIComponent(result.id)}`}>
                    <span className="muted">#{result.number}</span> {result.title}
                  </Link>
                </h3>
                <SeverityBadge severity={result.severity} />
              </div>
              <p className="meta">
                Resolved {result.resolvedAt ? relativeTime(result.resolvedAt) : "at an unknown time"}
              </p>
              {result.rootCause || result.fixApplied ? (
                <dl>
                  {result.rootCause ? (
                    <>
                      <dt>Root cause</dt>
                      <dd className="prewrap">{result.rootCause}</dd>
                    </>
                  ) : null}
                  {result.fixApplied ? (
                    <>
                      <dt>Fix applied</dt>
                      <dd className="prewrap">{result.fixApplied}</dd>
                    </>
                  ) : null}
                </dl>
              ) : (
                <p className="muted">No resolution details recorded.</p>
              )}
              {result.matchedTerms.length > 0 ? (
                <p>
                  <strong>Matched terms:</strong> {result.matchedTerms.join(", ")}
                </p>
              ) : null}
              <span className="visually-hidden">{SEVERITY_LABEL[result.severity]}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function SimilarIncidentsPanel({ incidentId }: { incidentId: string }) {
  const [state, setState] = useState<SimilarState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    api.similarIncidents(incidentId).then(
      (response: SimilarIncidentsDto) => {
        if (active) setState({ status: "loaded", results: response.results.slice(0, 5) });
      },
      (error: unknown) => {
        if (active) setState({ status: "error", message: errorText(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [incidentId, attempt]);

  return <SimilarIncidentsContent state={state} onRetry={() => setAttempt((value) => value + 1)} />;
}
