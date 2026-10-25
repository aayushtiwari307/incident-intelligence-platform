"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { GithubSettingsDto } from "@platform/shared";
import { AppShell, useCan } from "../../components/shell";
import { Field, FormError } from "../../components/ui";
import { errorText, relativeTime } from "../../lib/format";
import { api } from "../../lib/session";

export default function GithubPage() {
  return <AppShell><GithubSettings /></AppShell>;
}

function GithubSettings() {
  const canManage = useCan("integration:manage");
  const [settings, setSettings] = useState<GithubSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setSettings(await api.githubSettings()); }
    catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle() {
    if (!settings || !canManage) return;
    setBusy(true); setError(null); setNotice(null);
    try { setSettings(await api.updateGithubSettings(!settings.enabled)); setNotice(settings.enabled ? "GitHub issue enrichment disabled." : "GitHub issue enrichment enabled."); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget; const data = new FormData(form);
    setError(null); setNotice(null);
    try { await api.addGithubRepository(String(data.get("owner")).trim(), String(data.get("repo")).trim()); form.reset(); setNotice("Repository linked to this organization."); await load(); }
    catch (e) { setError(errorText(e)); }
  }

  async function remove(id: string, owner: string, repo: string) {
    if (!window.confirm(`Unlink ${owner}/${repo} from this organization?`)) return;
    setError(null); setNotice(null);
    try { await api.removeGithubRepository(id); setNotice("Repository unlinked."); await load(); }
    catch (e) { setError(errorText(e)); }
  }

  return (
    <>
      <p><Link href="/incidents">← Incidents</Link></p>
      <h1>GitHub issue enrichment</h1>
      <p className="muted">Optional, organization-scoped context from public GitHub issues and pull requests. The integration uses unauthenticated public API calls and caches results; private or inaccessible repositories may appear unavailable. Issue text is displayed as untrusted data and is never sent to AI by this feature.</p>
      <FormError message={error} />
      {notice ? <p role="status" className="notice">{notice}</p> : null}
      {settings ? <section aria-labelledby="github-enabled-h">
        <h2 id="github-enabled-h">Organization setting</h2>
        <p>Status: <strong>{settings.enabled ? "Enabled" : "Disabled (default)"}</strong></p>
        {canManage ? <button type="button" className="btn" disabled={busy} onClick={() => void toggle()}>{busy ? "Saving…" : settings.enabled ? "Disable enrichment" : "Enable enrichment"}</button> : <p className="muted">Only organization owners/admins can change this setting or linked repositories.</p>}
      </section> : <p role="status">Loading GitHub settings…</p>}

      {canManage && settings?.enabled ? <section aria-labelledby="repo-add-h">
        <h2 id="repo-add-h">Link a public repository</h2>
        <form className="card inline" onSubmit={add} aria-label="Link GitHub repository">
          <Field label="Owner" htmlFor="github-owner"><input id="github-owner" name="owner" required maxLength={39} pattern="(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)" /></Field>
          <Field label="Repository" htmlFor="github-repo"><input id="github-repo" name="repo" required maxLength={100} pattern="[A-Za-z0-9_.-]+" /></Field>
          <button type="submit" className="btn">Link repository</button>
        </form>
      </section> : null}

      <section aria-labelledby="repo-list-h">
        <h2 id="repo-list-h">Linked repositories</h2>
        {!settings?.repositories.length ? <p className="muted">No repositories linked.</p> : <ul className="plain">{settings.repositories.map((r) => <li key={r.id}>
          <a href={`https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`} target="_blank" rel="noreferrer">{r.owner}/{r.repo}</a> <span className="muted">· linked {relativeTime(r.linkedAt)}</span>{canManage ? <> {" "}<button type="button" className="btn-link danger" onClick={() => void remove(r.id, r.owner, r.repo)}>Unlink</button></> : null}
        </li>)}</ul>}
      </section>
    </>
  );
}
