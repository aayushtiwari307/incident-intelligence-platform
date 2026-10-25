"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_TRANSITIONS,
  type IncidentDto,
  type IncidentEventDto,
  type IncidentSeverity,
  type MemberDto,
} from "@platform/shared";
import { AiSuggestionsPanel, type AiDraftRequest } from "../../../components/ai-suggestions-panel";
import { AnalysisPanel } from "../../../components/analysis-panel";
import { SimilarIncidentsPanel } from "../../../components/similar-incidents-panel";
import { IncidentEnrichmentPanels } from "../../../components/incident-enrichment-panels";
import { AppShell, useCan } from "../../../components/shell";
import { Field, FormError, LiveStatus, SeverityBadge, StatusBadge } from "../../../components/ui";
import { ApiError } from "../../../lib/api-client";
import { ResolveForm } from "../../../components/resolve-form";
import { SEVERITY_LABEL, TRANSITION_VERB, describeEvent, errorText, relativeTime } from "../../../lib/format";
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

  if (missing) {
    return (
      <>
        <h1>Incident not found</h1>
        <p>
          It may not exist or you may not have access. <Link href="/incidents">Back to incidents</Link>
        </p>
      </>
    );
  }
  if (!incident) return error ? <FormError message={error} /> : <p role="status">Loading incident…</p>;

  const next = INCIDENT_TRANSITIONS[incident.status];
  const nextWithoutResolve = next.filter((status) => status !== "resolved");

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

  return (
    <>
      <p>
        <Link href="/incidents">← All incidents</Link>
      </p>
      <div className="page-head">
        <h1>
          <span className="muted">#{incident.number}</span> {incident.title}
        </h1>
        <LiveStatus status={liveStatus} />
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
            {editing ? "Cancel edit" : "Edit"}
          </button>
        ) : null}
      </div>
      <p className="meta">
        <SeverityBadge severity={incident.severity} /> <StatusBadge status={incident.status} /> · Assignee:{" "}
        {incident.assignee?.displayName ?? "Unassigned"} · Opened {relativeTime(incident.createdAt)}
        {incident.resolvedAt ? ` · Resolved ${relativeTime(incident.resolvedAt)}` : ""}
      </p>

      <FormError message={error} />
      {notice ? (
        <p role="status" className="notice">
          {notice}
        </p>
      ) : null}

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
        <section aria-labelledby="desc-h">
          <h2 id="desc-h">Description</h2>
          <p className="prewrap">{incident.description || <span className="muted">No description.</span>}</p>
        </section>
      )}

      {canTransition && next.length > 0 ? (
        <section aria-labelledby="status-h">
          <h2 id="status-h">Move to</h2>
          <div className="actions">
            {nextWithoutResolve.map((to) => (
              <button
                key={to}
                type="button"
                className="btn secondary"
                onClick={() => void mutate(() => api.transitionIncident(incident.id, { to, expectedVersion: incident.version }), `Status is now ${to}.`)}
              >
                {TRANSITION_VERB[to]}
              </button>
            ))}
            {next.includes("resolved") && !resolving ? (
              <button type="button" className="btn secondary" onClick={() => setResolving(true)}>
                Resolve
              </button>
            ) : null}
          </div>
          {resolving ? (
            <ResolveForm
              incidentId={incident.id}
              expectedVersion={incident.version}
              onCancel={() => setResolving(false)}
              onComplete={() => void handleResolveSuccess()}
              onTransitionFailure={handleResolveTransitionFailure}
            />
          ) : null}
        </section>
      ) : null}

      <IncidentEnrichmentPanels key={incident.id} incidentId={incident.id} canUpdate={canUpdate} refreshKey={serviceContextRefreshKey} />

      <SimilarIncidentsPanel incidentId={incident.id} />

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

      <section aria-labelledby="timeline-h">
        <h2 id="timeline-h">Timeline</h2>
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id} className={e.type === "comment" ? "comment" : undefined}>
              <div>
                <strong>{e.actor.label}</strong> {describeEvent(e)} <time dateTime={e.createdAt}>{relativeTime(e.createdAt)}</time>
              </div>
              {e.type === "comment" ? <p className="prewrap">{String(e.payload.body ?? "")}</p> : null}
              {e.type === "status_changed" && e.payload.note ? <p className="prewrap muted">{String(e.payload.note)}</p> : null}
            </li>
          ))}
        </ol>
        {canComment ? (
          <CommentForm
            key={commentDraft?.nonce ?? 0}
            initialBody={commentDraft?.body ?? ""}
            onSubmit={async (body) => {
              const ok = await mutate(() => api.comment(incident.id, body));
              if (ok) setCommentDraft(null);
              return ok;
            }}
          />
        ) : null}
      </section>
    </>
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
    <form className="card" onSubmit={submit} aria-label="Edit incident">
      <Field label="Title" htmlFor="edit-title">
        <input id="edit-title" name="title" defaultValue={incident.title} maxLength={200} required />
      </Field>
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
      <Field label="Description" htmlFor="edit-description">
        <textarea id="edit-description" name="description" rows={5} defaultValue={incident.description} maxLength={10000} />
      </Field>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Saving…" : "Save changes"}
      </button>
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
        <textarea id="comment-body" name="body" rows={initialBody ? 8 : 3} maxLength={5000} required defaultValue={initialBody} />
      </Field>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Posting…" : "Post comment"}
      </button>
    </form>
  );
}
