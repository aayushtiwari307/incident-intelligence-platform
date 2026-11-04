"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { GithubIssueContextDto, GithubIssueStatus, GithubSettingsDto, IncidentServiceContextDto, ServiceDto } from "@platform/shared";
import { Field, FormError } from "./ui";
import { errorText, relativeTime } from "../lib/format";
import { api } from "../lib/session";

/** Honest, plain-language wording for every state GitHub context can be in. */
const GITHUB_STATE: Partial<Record<GithubIssueStatus, { chip: string; tone: string; text: string }>> = {
  rate_limited: { chip: "Rate limited", tone: "warn", text: "GitHub is limiting requests. Details will load automatically on a later visit." },
  not_found_or_private: { chip: "Not found or private", tone: "bad", text: "The link is kept, but GitHub shows nothing for it. The repository may be private or the number may not exist." },
  unavailable: { chip: "Unavailable", tone: "warn", text: "GitHub could not be reached just now. The link is kept and details will load on a later visit." },
  invalid_response: { chip: "Unreadable", tone: "bad", text: "GitHub returned something unexpected, so nothing from it is shown. The link is kept." },
};

/**
 * The "Service and changes" and "GitHub" panels of an incident. They share loading state, so they live in one component;
 * `afterService` lets the page place another panel (similar incidents) between the two.
 */
export function IncidentEnrichmentPanels({
  incidentId,
  canUpdate,
  refreshKey = 0,
  afterService,
}: {
  incidentId: string;
  canUpdate: boolean;
  refreshKey?: number;
  afterService?: ReactNode;
}) {
  const [services, setServices] = useState<ServiceDto[]>([]);
  const [serviceContext, setServiceContext] = useState<IncidentServiceContextDto | null>(null);
  const [githubSettings, setGithubSettings] = useState<GithubSettingsDto | null>(null);
  const [githubContext, setGithubContext] = useState<GithubIssueContextDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fullLoadRequest = useRef(0);
  const serviceContextRequest = useRef(0);

  const refreshServiceContext = useCallback(async () => {
    const requestId = ++serviceContextRequest.current;
    try {
      const value = await api.incidentServiceContext(incidentId);
      if (requestId === serviceContextRequest.current) setServiceContext(value);
    } catch (reason) {
      if (requestId === serviceContextRequest.current) setError(errorText(reason));
    }
  }, [incidentId]);

  const load = useCallback(async () => {
    const requestId = ++fullLoadRequest.current;
    const serviceRequestId = ++serviceContextRequest.current;
    setError(null);
    const [serviceList, serviceInfo, ghSettings, ghInfo] = await Promise.allSettled([
      api.listServices(), api.incidentServiceContext(incidentId), api.githubSettings(), api.githubIssueContext(incidentId),
    ]);
    if (requestId !== fullLoadRequest.current) return;
    if (serviceList.status === "fulfilled") setServices(serviceList.value);
    else setError(errorText(serviceList.reason));
    if (serviceInfo.status === "fulfilled" && serviceRequestId === serviceContextRequest.current) setServiceContext(serviceInfo.value);
    if (ghSettings.status === "fulfilled") setGithubSettings(ghSettings.value);
    if (ghInfo.status === "fulfilled") setGithubContext(ghInfo.value);
  }, [incidentId]);

  useEffect(() => { void load(); }, [load]);

  // A change_context push can arrive while the incident page is already open. Refresh only this panel's
  // service context so the new correlated change appears without repeatedly hitting GitHub or reloading
  // unrelated panels for each notification.
  useEffect(() => {
    if (refreshKey === 0) return;
    // Coalesce bursts of change_context notifications into one read; a webhook may legitimately
    // notify several incidents at once and rapid deploys should not fan out unbounded browser requests.
    const timer = setTimeout(() => { void refreshServiceContext(); }, 150);
    return () => clearTimeout(timer);
  }, [incidentId, refreshKey, refreshServiceContext]);

  async function saveService(serviceId: string) {
    setBusy(true); setError(null);
    try { await api.linkIncidentService(incidentId, serviceId || null); await refreshServiceContext(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function linkIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget; const data = new FormData(form);
    setBusy(true); setError(null);
    try {
      await api.linkGithubIssue(incidentId, String(data.get("repositoryId")), Number(data.get("issueNumber")));
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function unlinkIssue() {
    setBusy(true); setError(null);
    try { await api.unlinkGithubIssue(incidentId); await load(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  const issue = githubContext?.issue;
  const link = githubContext?.link;
  const service = serviceContext?.service;
  const changes = serviceContext?.changes ?? [];
  const stateCopy = githubContext ? GITHUB_STATE[githubContext.status] : undefined;
  const kind = issue ? (issue.isPullRequest ? "Pull request" : "Issue") : "Issue or pull request";

  return (
    <>
      <section className="panel" aria-labelledby="service-changes-h">
        <h2 id="service-changes-h" className="label">Service and changes</h2>
        <FormError message={error} />
        {canUpdate ? (
          <Field label="Linked service" htmlFor="incident-service">
            <select id="incident-service" value={service?.id ?? ""} disabled={busy} onChange={(e) => void saveService(e.target.value)}>
              <option value="">No service linked</option>
              {services.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.ownerTeam} · {s.tier.toUpperCase()}</option>)}
            </select>
          </Field>
        ) : service ? null : <p className="muted">No service linked.</p>}
        {service ? <>
          <div className="row-between">
            <div><div className="title-sm">{service.name}</div><div className="hint">{service.ownerTeam}</div></div>
            <span className="chip plain">{service.tier.toUpperCase()}</span>
          </div>
          <hr className="divider" />
          <p className="hint" style={{ marginBottom: 10 }}>Changes in the 24 hours before this incident started. Correlation, not proof of cause.</p>
          {changes.length ? changes.map((change) => <div className="change-card" key={change.id} title={change.correlationLabel}>
            <div className="row-between" style={{ gap: 8 }}>
              <span className="ver">{change.version}</span>
              <time className="mono dim" style={{ fontSize: 11 }} dateTime={change.changedAt} title={change.changedAt}>{relativeTime(change.changedAt)}</time>
            </div>
            <div className="hint">{change.source} · by {change.actor}</div>
            <div className="hint mono" style={{ fontSize: 11 }}>event {change.externalId}</div>
          </div>) : <p className="muted">No matching change events in this window.</p>}
        </> : <p className="hint">Link a service to see what changed in the 24 hours before this incident started. <Link href="/services">Manage the service catalog</Link>.</p>}
      </section>

      {afterService}

      <section className="panel" aria-labelledby="github-h">
        <h2 id="github-h" className="label">GitHub</h2>
        {githubContext?.status === "disabled" ? <p className="hint">GitHub enrichment is off for this organization. An owner or admin can turn it on in <Link href="/github">GitHub settings</Link>.</p> : null}
        {githubContext?.status === "unlinked" ? <p className="hint">No issue or pull request linked. Allow a repository in <Link href="/github">GitHub settings</Link>, then link one here.</p> : null}
        {canUpdate && githubSettings?.enabled && !link ? (
          <form className="stack" style={{ gap: 12, marginTop: 12 }} onSubmit={linkIssue} aria-label="Link GitHub issue">
            <Field label="Repository" htmlFor="github-link-repo"><select id="github-link-repo" name="repositoryId" required defaultValue=""><option value="" disabled>Select an allowed repository</option>{githubSettings.repositories.map((r) => <option key={r.id} value={r.id}>{r.owner}/{r.repo}</option>)}</select></Field>
            <Field label="Issue or PR number" htmlFor="github-link-number"><input id="github-link-number" name="issueNumber" type="number" min={1} max={2147483647} step={1} required /></Field>
            <div className="actions"><button type="submit" className="btn accent" disabled={busy || githubSettings.repositories.length === 0}>Link issue</button></div>
          </form>
        ) : null}
        {link ? <>
          <div className="row-between" style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div className="title-sm">{kind} #{link.issueNumber}</div>
              <a className="mono small" style={{ overflowWrap: "anywhere" }} href={link.url} target="_blank" rel="noreferrer">{link.repository.owner}/{link.repository.repo}#{link.issueNumber}</a>
            </div>
            {stateCopy ? <span className={`chip ${stateCopy.tone}`}>{stateCopy.chip}</span> : githubContext?.status === "available" && issue ? <span className={`chip ${issue.state === "open" ? "ok" : "plain"}`}>{issue.state}</span> : null}
          </div>
          {issue ? <>
            <hr className="divider" />
            <h3 className="title-sm" style={{ overflowWrap: "anywhere" }}>{issue.title}</h3>
            <p className="hint" style={{ marginTop: 4 }}>{issue.isPullRequest ? "Pull request" : "Issue"} · {issue.state} · assigned to {issue.assignee ?? "nobody"} · updated {relativeTime(issue.updatedAt)}</p>
            {githubContext?.status === "available" ? <p className="hint mono" style={{ fontSize: 11, marginTop: 4 }}>Cached status refreshed</p> : null}
            {issue.labels.length ? <div className="chip-row" style={{ marginTop: 10, marginBottom: 0 }}>{issue.labels.map((l) => <span className="chip plain tiny" key={l.name}>{l.name}</span>)}</div> : null}
            {issue.bodyExcerpt ? <p className="prewrap small" style={{ marginTop: 10 }}>{issue.bodyExcerpt}</p> : null}
            {issue.recentActivity.length ? <>
              <h4 className="label" style={{ marginTop: 16 }}>Recent comments</h4>
              <ul className="plain stack" style={{ gap: 10 }}>{issue.recentActivity.map((activity, index) => <li className="well" key={`${activity.createdAt}-${index}`}><strong>{activity.author}</strong> <time className="mono dim" style={{ fontSize: 11 }} dateTime={activity.createdAt}>{relativeTime(activity.createdAt)}</time><p className="prewrap small" style={{ marginTop: 4 }}>{activity.body}</p></li>)}</ul>
            </> : null}
          </> : <p className="hint" style={{ marginTop: 12 }}>{stateCopy?.text ?? "Details are not available right now. The link is kept; try again later or check that the repository is public."}</p>}
          {canUpdate ? <div style={{ marginTop: 14 }}><button type="button" className="btn-link danger" disabled={busy} onClick={() => void unlinkIssue()}>Unlink issue</button></div> : null}
        </> : null}
      </section>
    </>
  );
}
