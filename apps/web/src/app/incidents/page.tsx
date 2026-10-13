"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, type IncidentDto, type IncidentSeverity, type IncidentStatus } from "@platform/shared";
import { AppShell, useCan } from "../../components/shell";
import { Field, FormError, LiveStatus, SeverityBadge, StatusBadge } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { SEVERITY_LABEL, STATUS_LABEL, errorText, relativeTime } from "../../lib/format";
import { matchesFilters, reconcileList } from "../../lib/realtime-state";
import { api, useSession } from "../../lib/session";
import { useRealtime } from "../../lib/use-realtime";

export default function IncidentsPage() {
  return (
    <AppShell>
      <IncidentList />
    </AppShell>
  );
}

function IncidentList() {
  const canCreate = useCan("incident:create");
  const { state } = useSession();
  const currentUserId = state.status === "authenticated" ? state.me.user.id : "";
  const [status, setStatus] = useState<IncidentStatus | "">("");
  const [severity, setSeverity] = useState<IncidentSeverity | "">("");
  const [assignee, setAssignee] = useState<"" | "me" | "unassigned">("");
  const [items, setItems] = useState<IncidentDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const requestSeq = useRef(0);
  const loading = useRef(false);
  const changedWhileLoading = useRef(false);
  // Live updates read the current filters and paging state without re-subscribing on every change.
  const live = useRef({ status, severity, assignee, hasMore: false, userId: currentUserId });
  live.current = { status, severity, assignee, hasMore: nextCursor !== null, userId: currentUserId };

  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      const seq = ++requestSeq.current; // ignore a slow response that was superseded by a newer filter choice
      loading.current = true;
      changedWhileLoading.current = false;
      setError(null);
      try {
        const page = await api.listIncidents({
          status: status || undefined,
          severity: severity || undefined,
          assignee: assignee || undefined,
          cursor,
        });
        if (seq !== requestSeq.current) return;
        setItems((prev) => (cursor && prev ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        loading.current = false;
        // A push arrived while this response was in flight: the response may predate it, so read again.
        if (changedWhileLoading.current) void load();
      } catch (e) {
        if (seq === requestSeq.current) {
          loading.current = false;
          setError(errorText(e));
        }
      }
    },
    [status, severity, assignee],
  );

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const liveStatus = useRealtime({
    onEvent: (message) => {
      if (loading.current) changedWhileLoading.current = true;
      const { status: s, severity: v, assignee: a, hasMore, userId } = live.current;
      const matches = matchesFilters(message.incident, { status: s, severity: v, assignee: a }, userId);
      setItems((prev) => (prev ? reconcileList(prev, hasMore, message.incident, matches) : prev));
    },
    onSync: () => void load(),
  });

  return (
    <>
      <div className="page-head">
        <h1>Incidents</h1>
        <LiveStatus status={liveStatus} />
        {canCreate ? (
          <button type="button" className="btn" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
            {creating ? "Cancel" : "New incident"}
          </button>
        ) : null}
      </div>

      {creating ? (
        <NewIncidentForm
          onCreated={(incident) => {
            setCreating(false);
            setItems((prev) => (prev ? [incident, ...prev] : [incident]));
          }}
        />
      ) : null}

      <form className="filters" aria-label="Filter incidents" onSubmit={(e) => e.preventDefault()}>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus | "")}>
            <option value="">All</option>
            {INCIDENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Severity
          <select value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity | "")}>
            <option value="">All</option>
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assignee
          <select value={assignee} onChange={(e) => setAssignee(e.target.value as "" | "me" | "unassigned")}>
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </label>
      </form>

      <FormError message={error} />
      {items === null && !error ? <p role="status">Loading incidents…</p> : null}
      {items && items.length === 0 ? (
        <p className="empty" role="status">
          No incidents match. {canCreate ? "Use “New incident” to open one." : ""}
        </p>
      ) : null}
      {items && items.length > 0 ? (
        <table className="table">
          <caption className="visually-hidden">Incidents, newest first</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Title</th>
              <th scope="col">Severity</th>
              <th scope="col">Status</th>
              <th scope="col">Assignee</th>
              <th scope="col">Opened</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.number}</td>
                <td>
                  <Link href={`/incidents/${i.id}`}>{i.title}</Link>
                </td>
                <td>
                  <SeverityBadge severity={i.severity} />
                </td>
                <td>
                  <StatusBadge status={i.status} />
                </td>
                <td>{i.assignee?.displayName ?? <span className="muted">Unassigned</span>}</td>
                <td title={i.createdAt}>{relativeTime(i.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {nextCursor ? (
        <button type="button" className="btn secondary" onClick={() => void load(nextCursor)}>
          Load more
        </button>
      ) : null}
    </>
  );
}

function NewIncidentForm({ onCreated }: { onCreated(incident: IncidentDto): void }) {
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setFields({});
    try {
      onCreated(
        await api.createIncident({
          title: String(form.get("title")),
          description: String(form.get("description")),
          severity: String(form.get("severity")) as IncidentSeverity,
        }),
      );
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length > 0) setFields(e.fieldErrors);
      else setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} noValidate aria-label="New incident">
      <FormError message={error} />
      <Field label="Title" htmlFor="new-title" error={fields.title}>
        <input id="new-title" name="title" maxLength={200} required autoFocus />
      </Field>
      <Field label="Severity" htmlFor="new-severity">
        <select id="new-severity" name="severity" defaultValue="sev3">
          {INCIDENT_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABEL[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What is happening?" htmlFor="new-description" error={fields.description}>
        <textarea id="new-description" name="description" rows={4} maxLength={10000} />
      </Field>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Opening…" : "Open incident"}
      </button>
    </form>
  );
}
