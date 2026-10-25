"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { GithubIssueContextDto, GithubSettingsDto, IncidentServiceContextDto, ServiceDto } from "@platform/shared";
import { Field, FormError } from "./ui";
import { errorText, relativeTime } from "../lib/format";
import { api } from "../lib/session";

export function IncidentEnrichmentPanels({ incidentId, canUpdate, refreshKey = 0 }: { incidentId: string; canUpdate: boolean; refreshKey?: number }) {
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

  return (
    <section aria-labelledby="context-h">
      <h2 id="context-h">Service and change context</h2>
      <FormError message={error} />
      <div className="card">
        <h3>Linked service</h3>
        {canUpdate ? (
          <Field label="Service" htmlFor="incident-service">
            <select id="incident-service" value={serviceContext?.service?.id ?? ""} disabled={busy} onChange={(e) => void saveService(e.target.value)}>
              <option value="">No service linked</option>
              {services.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.ownerTeam} · {s.tier.toUpperCase()}</option>)}
            </select>
          </Field>
        ) : serviceContext?.service ? <p>{serviceContext.service.name} · {serviceContext.service.ownerTeam} · {serviceContext.service.tier.toUpperCase()}</p> : <p className="muted">No service linked.</p>}
        {serviceContext?.service ? <>
          <p className="muted">Changes for this service in the 24 hours before the incident started. This is correlation, not proof of cause.</p>
          {serviceContext.changes.length ? <ol className="timeline">{serviceContext.changes.map((change) => <li key={change.id}>
            <div><strong>{change.serviceName}</strong> · {change.version} · by {change.actor} <time dateTime={change.changedAt}>{relativeTime(change.changedAt)}</time></div>
            <p className="muted">Source: {change.source} · event: {change.externalId} · {change.correlationLabel}</p>
          </li>)}</ol> : <p className="muted">No matching change events in this window.</p>}
        </> : <p className="muted">Choose a service to correlate incident history with deployment changes. <Link href="/services">Manage the service catalog</Link>.</p>}
      </div>

      <div className="card">
        <h3>GitHub issue or pull request</h3>
        {githubContext?.status === "disabled" ? <p className="muted">GitHub enrichment is disabled for this organization. An owner/admin can enable it in <Link href="/github">GitHub settings</Link>.</p> : null}
        {githubContext?.status === "unlinked" ? <p className="muted">No GitHub issue linked. Configure public repositories in <Link href="/github">GitHub settings</Link>.</p> : null}
        {canUpdate && githubSettings?.enabled && !link ? (
          <form className="inline" onSubmit={linkIssue} aria-label="Link GitHub issue">
            <Field label="Repository" htmlFor="github-link-repo"><select id="github-link-repo" name="repositoryId" required defaultValue=""><option value="" disabled>Select a linked repository</option>{githubSettings.repositories.map((r) => <option key={r.id} value={r.id}>{r.owner}/{r.repo}</option>)}</select></Field>
            <Field label="Issue or PR number" htmlFor="github-link-number"><input id="github-link-number" name="issueNumber" type="number" min={1} max={2147483647} step={1} required /></Field>
            <button type="submit" className="btn" disabled={busy || githubSettings.repositories.length === 0}>Link issue</button>
          </form>
        ) : null}
        {link ? <>
          <p><a href={link.url} target="_blank" rel="noreferrer">{link.repository.owner}/{link.repository.repo}#{link.issueNumber}</a> · <span className="muted">{githubContext?.status === "available" ? "Cached status refreshed" : `Status: ${githubContext?.status ?? "unknown"}`}</span></p>
          {issue ? <>
            <h4>{issue.title}</h4>
            <p>{issue.isPullRequest ? "Pull request" : "Issue"} · {issue.state} · assigned to {issue.assignee ?? "nobody"} · updated {relativeTime(issue.updatedAt)}</p>
            {issue.labels.length ? <p>Labels: {issue.labels.map((l) => l.name).join(", ")}</p> : null}
            {issue.bodyExcerpt ? <p className="prewrap">{issue.bodyExcerpt}</p> : null}
            {issue.recentActivity.length ? <><h4>Recent comments</h4><ul className="plain">{issue.recentActivity.map((activity, index) => <li key={`${activity.createdAt}-${index}`}><strong>{activity.author}</strong> <time dateTime={activity.createdAt}>{relativeTime(activity.createdAt)}</time><p className="prewrap">{activity.body}</p></li>)}</ul></> : null}
          </> : <p className="muted">Issue details are temporarily unavailable. The link is retained; try again later or check whether the repository is public.</p>}
          {canUpdate ? <button type="button" className="btn-link danger" disabled={busy} onClick={() => void unlinkIssue()}>Unlink issue</button> : null}
        </> : null}
      </div>
    </section>
  );
}
