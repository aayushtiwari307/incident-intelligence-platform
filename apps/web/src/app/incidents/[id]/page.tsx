"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_TRANSITIONS,
  type IncidentDto,
  type IncidentEventDto,
  type IncidentResolutionDto,
  type IncidentSeverity,
  type IncidentStatus,
  type MemberDto,
} from "@platform/shared";
import { AiSuggestionsPanel, type AiDraftRequest } from "../../../components/ai-suggestions-panel";
import { AnalysisPanel } from "../../../components/analysis-panel";
import { Icon } from "../../../components/icons";
import { SimilarIncidentsPanel } from "../../../components/similar-incidents-panel";
import { IncidentEnrichmentPanels } from "../../../components/incident-enrichment-panels";
import { AppShell, useCan } from "../../../components/shell";
import { StatusTrack } from "../../../components/status-track";
import { EmptyState, Field, FormError, LiveStatus, SeverityBadge, SkeletonRows, StatusBadge } from "../../../components/ui";
import { ApiError } from "../../../lib/api-client";
import { ResolveForm } from "../../../components/resolve-form";
import { SEVERITY_LABEL, TRANSITION_VERB, describeEvent, errorText, incidentRef, relativeTime } from "../../../lib/format";
import { acceptSnapshot, mergeTimeline } from "../../../lib/realtime-state";
import { api } from "../../../lib/session";
import { useRealtime } from "../../../lib/use-realtime";

export default function IncidentPage() {
  return (
    <AppShell>
      <IncidentDetail />
    </AppShell>
  );
}

function IncidentDetail() {
  const { id } = useParams<{ id: string }>();
  const canUpdate = useCan("incident:update");
  const canTransition = useCan("incident:transition");
  const canComment = useCan("incident:comment");

  const [incident, setIncident] = useState<IncidentDto | null>(null);
  const [events, setEvents] = useState<IncidentEventDto[]>([]);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [copied, setCopied] = useState(false);
  // The version the open edit form was based on. Live updates move `incident.version` forward while the user is typing;
  // saving must still be checked against what they were editing, or it would silently overwrite a colleague's change.
  const [editBaseVersion, setEditBaseVersion] = useState<number | null>(null);
  // An AI suggestion turned into a DRAFT: it only pre-fills the normal forms. Nothing is saved until a human submits.
  const [draftSeverity, setDraftSeverity] = useState<IncidentDto["severity"] | null>(null);
  const [commentDraft, setCommentDraft] = useState<{ body: string; nonce: number } | null>(null);
  const [serviceContextRefreshKey, setServiceContextRefreshKey] = useState(0);

  const reload = useCallback(async () => {
    try {
      const [inc, tl] = await Promise.all([api.getIncident(id), api.timeline(id)]);
      // Never step backwards: a push may already have delivered something newer than this response.
      setIncident((prev) => acceptSnapshot(prev, inc));
      setEvents((prev) => mergeTimeline(prev, tl));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(errorText(e));
    }
  }, [id]);

  const liveStatus = useRealtime({
    onEvent: (message) => {
      if (message.incidentId !== id) return;
      setIncident((prev) => acceptSnapshot(prev, message.incident));
      setEvents((prev) => mergeTimeline(prev, [message.event]));
      if (message.event.type === "change_context") setServiceContextRefreshKey((value) => value + 1);
    },
    onSync: () => {
      void reload();
      setServiceContextRefreshKey((value) => value + 1);
    },
  });

  useEffect(() => {
    void reload();
    api.listMembers().then(setMembers, () => setMembers([]));
  }, [reload]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  /** Runs a mutation; on an optimistic-concurrency conflict it reloads the latest state and tells the user. */
  async function mutate(action: () => Promise<unknown>, success?: string): Promise<boolean> {
    setError(null);
    setNotice(null);
    try {
      await action();
      await reload();
      if (success) setNotice(success);
      return true;
    } catch (e) {
      if (e instanceof ApiError && (e.code === "VERSION_CONFLICT" || e.code === "INVALID_TRANSITION")) {
        await reload();
        setError("Someone else changed this incident first. It has been reloaded; review it and try again.");
      } else {
        setError(errorText(e));
      }
      return false;
    }
  }

  async function copyLink() {
    setError(null);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setError("Clipboard access failed. Copy the address from the browser bar instead.");
    }
  }

  if (missing) {
    return (
      <section className="panel">
        <EmptyState center icon="incidents" title="Incident not found" action={<Link className="btn secondary" href="/incidents">Back to incidents</Link>}>
          It may not exist, or you may not have access to it.
        </EmptyState>
      </section>
    );
  }
  if (!incident) {
    return error ? (
      <FormError message={error} />
    ) : (
      <section className="panel flush">
        <SkeletonRows rows={4} label="Loading incident…" />
      </section>
    );
  }

  const next = INCIDENT_TRANSITIONS[incident.status];
  // The one obvious next step is the amber button: Resolve once mitigated, otherwise the first non-resolve step (reopen when resolved).
  const primaryTarget: IncidentStatus | null =
    incident.status === "mitigated" && next.includes("resolved") ? "resolved" : (next.find((status) => status !== "resolved") ?? (next.includes("resolved") ? "resolved" : null));
  const orderedNext = [...next].sort((a, b) => Number(b === primaryTarget) - Number(a === primaryTarget));

  async function handleResolveSuccess() {
    await reload();
    setResolving(false);
    setNotice("Incident resolved.");
  }

  async function handleResolveTransitionFailure(failure: unknown) {
    if (failure instanceof ApiError && (failure.code === "VERSION_CONFLICT" || failure.code === "INVALID_TRANSITION")) {
      await reload();
    }
  }

  const ref = incidentRef(incident.number);
  const newestFirst = [...events].reverse();

  return (
    <>
      <div className="crumbs">
        <div className="crumbs-trail">
          <Link href="/incidents">Incidents</Link> &nbsp;/&nbsp; <span>{ref}</span>
        </div>
        <div className="actions">
          <LiveStatus status={liveStatus} />
          <button type="button" className="btn secondary" onClick={() => void copyLink()}>
            <Icon name={copied ? "check" : "link"} size={14} />
            {copied ? "Link copied" : "Copy link"}
          </button>
          {canUpdate ? (
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setEditBaseVersion(editing ? null : incident.version);
                setDraftSeverity(null);
                setEditing((v) => !v);
              }}
              aria-expanded={editing}
            >
              <Icon name="pencil" size={14} />
              {editing ? "Cancel edit" : "Edit"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="incident-title">
        <div className="chip-row">
          <span className="chip accent">{ref}</span>
          <SeverityBadge severity={incident.severity} />
          <StatusBadge status={incident.status} />
        </div>
        <h1>{incident.title}</h1>
        <p className="meta">
          <span title={incident.createdAt}>
            Opened {relativeTime(incident.createdAt)}
            {incident.createdBy ? ` by ${incident.createdBy.displayName}` : ""}
          </span>
          {incident.resolvedAt ? <span title={incident.resolvedAt}> · Resolved {relativeTime(incident.resolvedAt)}</span> : null}
          {" · "}
          {incident.assignee ? `Assigned to ${incident.assignee.displayName}` : "No assignee"}
        </p>
      </div>

      <FormError message={error} />
      {notice ? (
        <p role="status" className="notice ok">
          {notice}
        </p>
      ) : null}

      <section className="panel roomy" aria-labelledby="progress-h">
        <h2 id="progress-h" className="label">Progress</h2>
        <StatusTrack incident={incident} events={events} />
        {canTransition && next.length > 0 ? (
          <div className="track-actions actions" role="group" aria-label="Move this incident to another status">
            {orderedNext.map((to) =>
              to === "resolved" ? (
                resolving ? null : (
                  <button key={to} type="button" className={to === primaryTarget ? "btn" : "btn secondary"} onClick={() => setResolving(true)}>
                    Resolve
                  </button>
                )
              ) : (
                <button
                  key={to}
                  type="button"
                  className={to === primaryTarget ? "btn" : "btn secondary"}
                  onClick={() => void mutate(() => api.transitionIncident(incident.id, { to, expectedVersion: incident.version }), `Status is now ${to}.`)}
                >
                  {incident.status === "resolved" ? "Reopen" : TRANSITION_VERB[to]}
                </button>
              ),
            )}
          </div>
        ) : null}
      </section>

      {resolving && canTransition ? (
        <ResolveForm
          incidentId={incident.id}
          expectedVersion={incident.version}
          onCancel={() => setResolving(false)}
          onComplete={() => void handleResolveSuccess()}
          onTransitionFailure={handleResolveTransitionFailure}
        />
      ) : null}

      <div className="cols mt">
        <div className="col-main stack">
          {editing ? (
            <>
              {editBaseVersion !== null && incident.version > editBaseVersion ? (
                <p role="status" className="notice">
                  Someone else changed this incident while you were editing. Saving will be refused so nothing is overwritten; copy your
                  changes, cancel, and edit again.
                </p>
              ) : null}
              {draftSeverity ? (
                <p role="status" className="notice">
                  AI-suggested severity {SEVERITY_LABEL[draftSeverity]} is pre-selected as a draft. Review it and save, or change it.
                </p>
              ) : null}
              <EditForm
                key={draftSeverity ?? "plain"}
                draftSeverity={draftSeverity}
                incident={incident}
                members={members}
                onSave={async (input) => {
                  const expectedVersion = editBaseVersion ?? incident.version;
                  if (await mutate(() => api.updateIncident(incident.id, { expectedVersion, ...input }), "Saved.")) {
                    setEditing(false);
                    setEditBaseVersion(null);
                  }
                }}
              />
            </>
          ) : (
            <section className="panel" aria-labelledby="desc-h">
              <h2 id="desc-h" className="label">Description</h2>
              {incident.description ? <p className="prewrap" style={{ fontSize: 15 }}>{incident.description}</p> : <p className="muted">No description was added. Use Edit to describe what is happening.</p>}
            </section>
          )}

          <ResolutionPanel incident={incident} canUpdate={canUpdate} onSaved={() => void reload()} />

          <section className="panel" aria-labelledby="timeline-h">
            <h2 id="timeline-h" className="label">Timeline</h2>
            {canComment ? (
              <div className="composer">
                <CommentForm
                  key={commentDraft?.nonce ?? 0}
                  initialBody={commentDraft?.body ?? ""}
                  onSubmit={async (body) => {
                    const ok = await mutate(() => api.comment(incident.id, body));
                    if (ok) setCommentDraft(null);
                    return ok;
                  }}
                />
              </div>
            ) : null}
            <ol className="timeline">
              {newestFirst.map((e, index) => {
                const resolvedEvent = e.type === "status_changed" && e.payload.to === "resolved";
                const cls = [index === 0 ? "latest" : "", resolvedEvent ? "t-resolved" : "", e.type === "comment" ? "t-comment" : ""].filter(Boolean).join(" ");
                return (
                  <li key={e.id} className={cls || undefined}>
                    <div className="what">
                      <strong>{e.actor.label}</strong> {describeEvent(e)}
                    </div>
                    <div className="when">
                      <time dateTime={e.createdAt} title={e.createdAt}>{relativeTime(e.createdAt)}</time>
                    </div>
                    {e.type === "comment" ? <p className="prewrap bubble">{String(e.payload.body ?? "")}</p> : null}
                    {e.type === "status_changed" && e.payload.note ? <p className="prewrap bubble note">{String(e.payload.note)}</p> : null}
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        <aside className="col-rail stack" aria-label="Incident context">
          <section className="panel" aria-labelledby="details-h">
            <h2 id="details-h" className="label">Details</h2>
            <dl className="kv">
              <div>
                <dt>Severity</dt>
                <dd><SeverityBadge severity={incident.severity} /></dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd><StatusBadge status={incident.status} /></dd>
              </div>
              <div>
                <dt>Assignee</dt>
                <dd>{incident.assignee?.displayName ?? "Unassigned"}</dd>
              </div>
              <div>
                <dt>Opened</dt>
                <dd className="mono" style={{ fontSize: 12 }} title={incident.createdAt}>{relativeTime(incident.createdAt)}</dd>
              </div>
              {incident.resolvedAt ? (
                <div>
                  <dt>Resolved</dt>
                  <dd className="mono" style={{ fontSize: 12 }} title={incident.resolvedAt}>{relativeTime(incident.resolvedAt)}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <IncidentEnrichmentPanels
            key={incident.id}
            incidentId={incident.id}
            canUpdate={canUpdate}
            refreshKey={serviceContextRefreshKey}
            afterService={<SimilarIncidentsPanel incidentId={incident.id} />}
          />

          <AiSuggestionsPanel
            incident={incident}
            onDraft={(draft: AiDraftRequest) => {
              if (draft.severity && canUpdate) {
                setEditBaseVersion(incident.version);
                setDraftSeverity(draft.severity);
                setEditing(true);
              }
              if (draft.commentBody) setCommentDraft({ body: draft.commentBody, nonce: Date.now() });
            }}
          />

          <AnalysisPanel
            incident={incident}
            onApplySeverity={async (severity) => {
              await mutate(() => api.updateIncident(incident.id, { expectedVersion: incident.version, severity }), `Severity set to ${severity.toUpperCase()}.`);
            }}
          />
        </aside>
      </div>
    </>
  );
}

type ResolutionState = { status: "loading" } | { status: "none" } | { status: "error"; message: string } | { status: "loaded"; resolution: IncidentResolutionDto };

/**
 * What was wrong and what fixed it. Shown for resolved incidents (and whenever notes exist). Reads and creates through the
 * same resolution endpoints the resolve form already uses; nothing here changes how resolving works.
 */
function ResolutionPanel({ incident, canUpdate, onSaved }: { incident: IncidentDto; canUpdate: boolean; onSaved(): void }) {
  const [state, setState] = useState<ResolutionState>({ status: "loading" });
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.getIncidentResolution(incident.id).then(
      (resolution) => {
        if (active) setState({ status: "loaded", resolution });
      },
      (e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 404) setState({ status: "none" });
        else setState({ status: "error", message: errorText(e) });
      },
    );
    return () => {
      active = false;
    };
  }, [incident.id, incident.version]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rootCause = String(data.get("rootCause")).trim();
    const fixApplied = String(data.get("fixApplied")).trim();
    if (!rootCause || !fixApplied) {
      setFormError("Enter both the root cause and the fix that was applied.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const resolution = await api.createIncidentResolution(incident.id, { rootCause, fixApplied });
      setState({ status: "loaded", resolution });
      setAdding(false);
      onSaved();
    } catch (e) {
      setFormError(e instanceof ApiError && e.status === 409 ? "Resolution notes were already saved by someone else. Reload to see them." : errorText(e));
    }
    setBusy(false);
  }

  if (state.status !== "loaded" && incident.status !== "resolved") return null;

  return (
    <section className="panel" aria-labelledby="resolution-h">
      <h2 id="resolution-h" className="label">Resolution</h2>
      {state.status === "loading" ? <p className="hint" role="status">Loading resolution notes…</p> : null}
      {state.status === "error" ? <p role="alert" className="form-error">{state.message}</p> : null}
      {state.status === "loaded" ? (
        <>
          <dl className="defs" style={{ marginTop: 0 }}>
            <dt style={{ marginTop: 0 }}>Root cause</dt>
            <dd className="prewrap">{state.resolution.rootCause}</dd>
            <dt>Fix applied</dt>
            <dd className="prewrap">{state.resolution.fixApplied}</dd>
          </dl>
          <p className="hint mono" style={{ fontSize: 11, marginTop: 14 }} title={state.resolution.updatedAt}>
            Recorded {relativeTime(state.resolution.createdAt)}
          </p>
        </>
      ) : null}
      {state.status === "none" && !adding ? (
        <EmptyState
          icon="pencil"
          title="No resolution notes yet"
          action={
            canUpdate ? (
              <button type="button" className="btn accent" onClick={() => setAdding(true)}>
                Add resolution
              </button>
            ) : undefined
          }
        >
          Record the root cause and the fix. Future incidents with similar symptoms will surface it.
        </EmptyState>
      ) : null}
      {state.status === "none" && adding ? (
        <form onSubmit={submit} aria-label="Add resolution notes">
          <FormError message={formError} />
          <Field label="Root cause" htmlFor="add-root-cause">
            <textarea id="add-root-cause" name="rootCause" rows={3} maxLength={2000} required />
          </Field>
          <Field label="Fix applied" htmlFor="add-fix-applied">
            <textarea id="add-fix-applied" name="fixApplied" rows={3} maxLength={2000} required />
          </Field>
          <div className="actions">
            <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save resolution"}</button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => { setAdding(false); setFormError(null); }}>Cancel</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function EditForm({
  incident,
  members,
  draftSeverity = null,
  onSave,
}: {
  incident: IncidentDto;
  draftSeverity?: IncidentSeverity | null;
  members: MemberDto[];
  onSave(input: { title: string; description: string; severity: IncidentSeverity; assigneeId: string | null }): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    await onSave({
      title: String(form.get("title")),
      description: String(form.get("description")),
      severity: String(form.get("severity")) as IncidentSeverity,
      assigneeId: String(form.get("assignee")) || null,
    });
    setBusy(false);
  }
  return (
    <form className="panel" onSubmit={submit} aria-label="Edit incident">
      <h2 className="label">Edit incident</h2>
      <Field label="Title" htmlFor="edit-title">
        <input id="edit-title" name="title" defaultValue={incident.title} maxLength={200} required />
      </Field>
      <div className="form-grid" style={{ marginBottom: 16 }}>
        <Field label="Severity" htmlFor="edit-severity">
          <select id="edit-severity" name="severity" defaultValue={draftSeverity ?? incident.severity}>
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assignee" htmlFor="edit-assignee">
          <select id="edit-assignee" name="assignee" defaultValue={incident.assignee?.id ?? ""}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description" htmlFor="edit-description">
        <textarea id="edit-description" name="description" rows={5} defaultValue={incident.description} maxLength={10000} />
      </Field>
      <div className="actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function CommentForm({ onSubmit, initialBody = "" }: { onSubmit(body: string): Promise<boolean>; initialBody?: string }) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(new FormData(form).get("body")).trim();
    if (!body) return;
    setBusy(true);
    if (await onSubmit(body)) form.reset();
    setBusy(false);
  }
  return (
    <form onSubmit={submit} aria-label="New comment" className="comment-form">
      <Field label="Add a comment" htmlFor="comment-body">
        <textarea id="comment-body" name="body" rows={initialBody ? 8 : 3} maxLength={5000} required defaultValue={initialBody} placeholder="What did you see, try or decide?" />
      </Field>
      <div className="actions">
        <button type="submit" className="btn accent" disabled={busy}>
          {busy ? "Posting…" : "Post comment"}
        </button>
      </div>
    </form>
  );
}
