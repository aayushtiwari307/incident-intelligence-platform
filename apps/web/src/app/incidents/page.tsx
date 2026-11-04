"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, type IncidentDto, type IncidentSeverity, type IncidentStatus } from "@platform/shared";
import { Icon } from "../../components/icons";
import { AppShell, useCan } from "../../components/shell";
import { Avatar, EmptyState, Field, FormError, LiveStatus, PageHeader, SeverityBadge, SkeletonRows, StatusBadge } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { SEVERITY_LABEL, STATUS_LABEL, errorText, incidentRef, relativeTime } from "../../lib/format";
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

const STATUS_TABS: Array<{ value: IncidentStatus | ""; label: string }> = [{ value: "", label: "All" }, ...INCIDENT_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))];

function IncidentList() {
  const router = useRouter();
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
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestSeq = useRef(0);
  const loading = useRef(false);
  const changedWhileLoading = useRef(false);
  // Live updates read the current filters and paging state without re-subscribing on every change.
  const live = useRef({ status, severity, assignee, hasMore: false, userId: currentUserId });
  live.current = { status, severity, assignee, hasMore: nextCursor !== null, userId: currentUserId };
  // Keyboard navigation reads the same way, so the key handler is registered once.
  const keys = useRef<{ items: IncidentDto[]; active: number }>({ items: [], active: -1 });
  keys.current = { items: items ?? [], active: activeIndex };

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
    setActiveIndex(-1);
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

  // J / K move a highlight through the rows and Enter opens it. Ignored while typing, in dialogs, or on a focused control.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const { items: rows, active } = keys.current;
      if (rows.length === 0) return;
      const key = event.key.toLowerCase();
      if (key === "j") {
        setActiveIndex(Math.min(rows.length - 1, active + 1));
      } else if (key === "k") {
        setActiveIndex(Math.max(0, active - 1));
      } else if (key === "enter" && active >= 0 && (!target || target === document.body || target.id === "main")) {
        const row = rows[active];
        if (row) router.push(`/incidents/${encodeURIComponent(row.id)}`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  useEffect(() => {
    if (activeIndex >= 0) document.querySelector(`[data-row-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <>
      <PageHeader
        title="Incidents"
        actions={
          <>
            <LiveStatus status={liveStatus} />
            {canCreate ? (
              <button type="button" className="btn" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
                {creating ? (
                  "Cancel"
                ) : (
                  <>
                    <Icon name="plus" size={14} stroke={3} />
                    New incident
                  </>
                )}
              </button>
            ) : null}
          </>
        }
      >
        Everything your team is tracking, newest first.
      </PageHeader>

      {creating ? (
        <NewIncidentForm
          onCreated={(incident) => {
            setCreating(false);
            setItems((prev) => (prev ? [incident, ...prev] : [incident]));
          }}
        />
      ) : null}

      <form className="toolbar" aria-label="Filter incidents" onSubmit={(e) => e.preventDefault()}>
        <div className="segmented" role="group" aria-label="Filter by status">
          {STATUS_TABS.map((tab) => (
            <button key={tab.value || "all"} type="button" aria-pressed={status === tab.value} onClick={() => setStatus(tab.value)}>
              {tab.label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <label className="mini-select">
            <span className="visually-hidden">Severity</span>
            <select value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity | "")}>
              <option value="">All severities</option>
              {INCIDENT_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="mini-select">
            <span className="visually-hidden">Assignee</span>
            <select value={assignee} onChange={(e) => setAssignee(e.target.value as "" | "me" | "unassigned")}>
              <option value="">Anyone</option>
              <option value="me">Assigned to me</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
          <span className="hotkeys" aria-hidden="true">
            <span className="kbd">J</span> <span className="kbd">K</span> move &nbsp; <span className="kbd">Enter</span> open
          </span>
        </div>
      </form>

      <FormError message={error} />
      <section className="panel flush" aria-label="Incident list">
        {items === null && !error ? <SkeletonRows rows={5} label="Loading incidents…" /> : null}
        {items && items.length === 0 ? (
          <EmptyState center icon="incidents" title="No incidents match these filters" action={undefined}>
            {status || severity || assignee ? "Try another status or severity, or clear the filters to see everything." : "Alerts from Alertmanager appear here automatically."}
            {canCreate ? " You can also open one by hand with New incident." : ""}
          </EmptyState>
        ) : null}
        {items && items.length > 0 ? (
          <ul className="incident-list">
            {items.map((i, index) => (
              <li
                key={i.id}
                data-row-index={index}
                className={`irow sev-${i.severity}${i.status === "resolved" ? " is-resolved" : ""}${index === activeIndex ? " is-active" : ""}`}
              >
                <span className="sevbar" aria-hidden="true" />
                <span className="ref">{incidentRef(i.number)}</span>
                <div className="irow-main">
                  <Link className="title" href={`/incidents/${i.id}`}>
                    {i.title}
                  </Link>
                  <div className="sub" title={i.createdAt}>
                    Opened {relativeTime(i.createdAt)}
                    {i.resolvedAt ? ` · resolved ${relativeTime(i.resolvedAt)}` : ""}
                  </div>
                </div>
                <SeverityBadge severity={i.severity} />
                <StatusBadge status={i.status} />
                <Avatar name={i.assignee?.displayName} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {items && items.length > 0 ? (
        <div className="list-foot">
          <span>
            Showing {items.length} incident{items.length === 1 ? "" : "s"}
            {nextCursor ? " so far" : ""}. Updates appear live when real-time is on.
          </span>
          {nextCursor ? (
            <button type="button" className="btn secondary" onClick={() => void load(nextCursor)}>
              Load more
            </button>
          ) : null}
        </div>
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
    <form className="panel mt-lg panel-form" onSubmit={submit} noValidate aria-label="New incident">
      <h2 className="label">New incident</h2>
      <FormError message={error} />
      <div className="form-grid" style={{ marginBottom: 16 }}>
        <div className="field wide">
          <label htmlFor="new-title">Title</label>
          <input id="new-title" name="title" maxLength={200} required autoFocus placeholder="What is broken, in a few words" aria-describedby={fields.title ? "new-title-error" : undefined} />
          {fields.title ? (
            <p id="new-title-error" className="field-error">
              {fields.title}
            </p>
          ) : null}
        </div>
        <div className="field" style={{ flex: "1 1 180px" }}>
          <label htmlFor="new-severity">Severity</label>
          <select id="new-severity" name="severity" defaultValue="sev3">
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Field label="What is happening?" htmlFor="new-description" error={fields.description}>
        <textarea id="new-description" name="description" rows={4} maxLength={10000} placeholder="Symptoms, who is affected, what you have tried" />
      </Field>
      <div className="actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Opening…" : "Open incident"}
        </button>
      </div>
    </form>
  );
}
