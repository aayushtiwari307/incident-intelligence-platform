"use client";

import { useCallback, useEffect, useState } from "react";
import type { AiSettingsDto } from "@platform/shared";
import { errorText } from "../lib/format";
import { api } from "../lib/session";

/** Presentational: owner/admin switch for AI suggestions. Off by default; the server switch can never be changed from here. */
export function AiSettingsView({ settings, busy, error, onToggle }: { settings: AiSettingsDto | null; busy: boolean; error: string | null; onToggle(next: boolean): void }) {
  return (
    <section aria-labelledby="ai-settings-h" className="card">
      <h2 id="ai-settings-h" style={{ marginTop: 0 }}>
        AI suggestions
      </h2>
      <div role="alert" className="form-error">
        {error}
      </div>
      {!settings ? <p role="status">Loading…</p> : null}
      {settings && !settings.serverEnabled ? (
        <p className="muted">AI suggestions are not enabled on this server, so this setting has no effect yet.</p>
      ) : null}
      {settings ? (
        <>
          <p>
            Status: <strong>{settings.organizationOptIn ? "On for this organization" : "Off for this organization"}</strong>
          </p>
          <p className="muted">
            When on, a responder can ask for a suggestion on an incident. The incident text (redacted on a best-effort basis) is sent to the configured AI provider.
            Suggestions are drafts only: a person reviews and saves everything. Daily allowance: {settings.usedToday} of {settings.dailyLimit} used today (UTC).
          </p>
          <button type="button" className="btn secondary" disabled={busy} aria-pressed={settings.organizationOptIn} onClick={() => onToggle(!settings.organizationOptIn)}>
            {settings.organizationOptIn ? "Turn off AI suggestions" : "Turn on AI suggestions"}
          </button>
        </>
      ) : null}
    </section>
  );
}

export function AiSettingsPanel() {
  const [settings, setSettings] = useState<AiSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setSettings(await api.aiSettings());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <AiSettingsView
      settings={settings}
      busy={busy}
      error={error}
      onToggle={(next) => {
        setBusy(true);
        setError(null);
        api
          .updateAiSettings(next)
          .then(setSettings)
          .catch((e) => setError(errorText(e)))
          .finally(() => setBusy(false));
      }}
    />
  );
}
