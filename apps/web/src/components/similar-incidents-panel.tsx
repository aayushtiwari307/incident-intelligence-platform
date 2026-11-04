"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { SimilarIncidentDto, SimilarIncidentsDto } from "@platform/shared";
import { api } from "../lib/session";
import { errorText, incidentRef, relativeTime } from "../lib/format";
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
    <section className="panel" aria-labelledby="similar-incidents-heading">
      <h2 id="similar-incidents-heading" className="label">
        Similar incidents
      </h2>
      {state.status === "loading" ? <p role="status" className="hint">Finding similar incidents…</p> : null}
      {state.status === "error" ? (
        <div>
          <p role="alert" className="form-error">{state.message}</p>
          <button type="button" className="btn secondary" onClick={onRetry}>
            Retry loading similar incidents
          </button>
        </div>
      ) : null}
      {state.status === "loaded" && state.results.length === 0 ? (
        <div role="status">
          <div className="title-sm">Nothing similar yet</div>
          <div className="hint">Resolved incidents with a recorded fix appear here, ranked by matching terms.</div>
        </div>
      ) : null}
      {state.status === "loaded" && state.results.length > 0 ? (
        <ol className="plain">
          {state.results.slice(0, 5).map((result) => (
            <li key={result.id} className="similar-item">
              <div className="row-between" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                <h3 style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <Link href={`/incidents/${encodeURIComponent(result.id)}`}>
                    <span className="mono dim" style={{ fontSize: 12 }}>{incidentRef(result.number)}</span> {result.title}
                  </Link>
                </h3>
                <SeverityBadge severity={result.severity} />
              </div>
              <p className="hint mono" style={{ fontSize: 11, marginTop: 2 }}>
                Resolved {result.resolvedAt ? relativeTime(result.resolvedAt) : "at an unknown time"}
              </p>
              {result.rootCause || result.fixApplied ? (
                <dl>
                  {result.rootCause ? (
                    <div>
                      <dt>Root cause</dt>
                      <dd className="prewrap">{result.rootCause}</dd>
                    </div>
                  ) : null}
                  {result.fixApplied ? (
                    <div>
                      <dt>Fix applied</dt>
                      <dd className="prewrap">{result.fixApplied}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <p className="hint" style={{ marginTop: 8 }}>No resolution details recorded.</p>
              )}
              {result.matchedTerms.length > 0 ? (
                <div className="tags" aria-label="Matched terms">
                  <span className="hint">Matched terms:</span>
                  {result.matchedTerms.map((term) => (
                    <span className="chip plain tiny" key={term}>{term}</span>
                  ))}
                </div>
              ) : null}
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
