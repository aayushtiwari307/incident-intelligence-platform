"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { GithubSettingsDto } from "@platform/shared";
import { Icon } from "../../components/icons";
import { AppShell, useCan } from "../../components/shell";
import { FormError, PageHeader, SkeletonRows } from "../../components/ui";
import { errorText, relativeTime } from "../../lib/format";
import { api } from "../../lib/session";

export default function GithubPage() {
  return <AppShell><GithubSettings /></AppShell>;
}

/** Accepts "owner/repo", "github.com/owner/repo" or a pasted https URL; the server still validates both parts strictly. */
function parseRepository(input: string): { owner: string; repo: string } | null {
  const cleaned = input.trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = cleaned.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
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
    const parsed = parseRepository(String(data.get("repository")));
    if (!parsed) { setError("Enter the repository as owner/repository, for example aayushtiwari307/incident-intelligence-platform."); return; }
    try { await api.addGithubRepository(parsed.owner, parsed.repo); form.reset(); setNotice("Repository linked to this organization."); await load(); }
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
      <PageHeader title="GitHub context">
        Attach public issues and pull requests to incidents. Read-only: no GitHub token is stored, and only repositories you allow are ever queried.
      </PageHeader>
      <div className="mt-lg" />
      <FormError message={error} />
      {notice ? <p role="status" className="notice ok">{notice}</p> : null}
      {!settings && !error ? <div className="panel flush"><SkeletonRows rows={2} label="Loading GitHub settings…" /></div> : null}

      {settings ? (
        <div className="cols" style={{ gap: 20 }}>
          <div className="col-main stack loose">
            <section className="panel roomy" aria-labelledby="github-enabled-h">
              <div className="row-between" style={{ gap: 16 }}>
                <div style={{ flex: "1 1 260px" }}>
                  <h2 id="github-enabled-h" className="label" style={{ marginBottom: 8 }}>Enrichment</h2>
                  <div className="title-md">{settings.enabled ? "Enabled for this organization" : "Off for this organization"}</div>
                  <div className="hint">
                    {settings.enabled
                      ? "Responders can link an incident to an issue or pull request from an allowed repository."
                      : canManage ? "Turn this on to let responders link incidents to issues and pull requests from allowed repositories." : "Only organization owners and admins can change this setting or the allowed repositories."}
                  </div>
                </div>
                {canManage ? <button type="button" role="switch" aria-checked={settings.enabled} aria-label="GitHub enrichment" className="switch" disabled={busy} onClick={() => void toggle()} /> : null}
              </div>
            </section>

            <section className="panel roomy" aria-labelledby="repo-list-h">
              <h2 id="repo-list-h" className="label">Allowed repositories</h2>
              {canManage && settings.enabled ? (
                <form className="form-grid" style={{ marginBottom: 18 }} onSubmit={add} aria-label="Allow a GitHub repository">
                  <div className="field wide"><label htmlFor="github-repository">Repository</label><input id="github-repository" name="repository" className="mono" required maxLength={141} placeholder="owner/repository" autoComplete="off" spellCheck={false} /></div>
                  <button type="submit" className="btn accent">Allow repository</button>
                </form>
              ) : canManage ? <p className="hint" style={{ marginBottom: 14 }}>Turn enrichment on to allow repositories.</p> : null}
              {settings.repositories.length === 0 ? (
                <div className="well"><div className="title-sm">No repositories allowed yet</div><div className="hint">Incidents can only link to issues and pull requests from repositories listed here.</div></div>
              ) : (
                <ul className="plain stack" style={{ gap: 10 }}>{settings.repositories.map((r) => (
                  <li key={r.id} className="well row-between" style={{ padding: "14px 16px" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                      <span style={{ color: "var(--muted)", display: "inline-flex" }}><Icon name="github" size={18} stroke={1.8} /></span>
                      <a className="mono small" style={{ overflowWrap: "anywhere" }} href={`https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`} target="_blank" rel="noreferrer">{r.owner}/{r.repo}</a>
                      <span className="hint">linked {relativeTime(r.linkedAt)}</span>
                    </span>
                    {canManage ? <button type="button" className="btn-link danger" onClick={() => void remove(r.id, r.owner, r.repo)}>Remove</button> : null}
                  </li>
                ))}</ul>
              )}
            </section>
          </div>

          <aside className="col-rail" style={{ flex: "1 1 300px" }}>
            <section className="panel roomy" aria-labelledby="behaves-h">
              <h2 id="behaves-h" className="label">How it behaves</h2>
              <ul className="plain stack" style={{ gap: 14, fontSize: 13 }}>
                <li style={{ display: "flex", gap: 10 }}><span style={{ color: "var(--ok)" }} aria-hidden="true">●</span><span>Public data only, fetched from <span className="mono">api.github.com</span>.</span></li>
                <li style={{ display: "flex", gap: 10 }}><span style={{ color: "var(--ok)" }} aria-hidden="true">●</span><span>Results are cached for 5 minutes to stay within GitHub&rsquo;s free limits.</span></li>
                <li style={{ display: "flex", gap: 10 }}><span style={{ color: "#fbbf24" }} aria-hidden="true">●</span><span>If GitHub rate-limits a request, the incident shows <span className="chip warn tiny">Rate limited</span> and retries later.</span></li>
                <li style={{ display: "flex", gap: 10 }}><span style={{ color: "#7dd3fc" }} aria-hidden="true">●</span><span>GitHub content is never sent to AI.</span></li>
              </ul>
            </section>
          </aside>
        </div>
      ) : null}
    </>
  );
}
