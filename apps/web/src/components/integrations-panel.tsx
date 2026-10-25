"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CreatedIntegrationDto, IntegrationDto, IntegrationKind } from "@platform/shared";
import { Field, FormError } from "./ui";
import { errorText, relativeTime } from "../lib/format";
import { api } from "../lib/session";

/**
 * Alertmanager integration credentials (admins and owners only; the parent decides whether to render this).
 *
 * The plaintext token lives ONLY in this component's React state, from the moment the server returns it until the user
 * dismisses it, navigates away or reloads. It is never written to local/session storage, the URL or the DOM outside the
 * one-time reveal box. The list shows metadata only, because the server cannot return a token it does not store.
 */
export function IntegrationsPanel() {
  const [items, setItems] = useState<IntegrationDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ token: string; name: string; kind: IntegrationKind; action: "created" | "rotated" } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api.listIntegrations());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function reveal(result: CreatedIntegrationDto, action: "created" | "rotated") {
    setRevealed({ token: result.token, name: result.name, kind: result.kind, action });
    setCopied(false);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError(null);
    try {
      const formData = new FormData(form);
      reveal(await api.createIntegration(String(formData.get("name")).trim(), String(formData.get("kind")) as IntegrationKind), "created");
      form.reset();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function act(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    }
    await load();
  }

  async function copy(value: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setError("Clipboard access failed. Please copy the displayed token manually.");
    }
  }

  return (
    <section aria-labelledby="integrations-h">
      <h2 id="integrations-h">Integrations</h2>
      <p className="muted">
        Create a separate credential for each sender. Alertmanager credentials go to <code>/api/v1/integrations/alertmanager</code>; deployment/change senders go to{" "}
        <code>/api/v1/integrations/changes</code>. Send each token as a Bearer token. Change payloads are documented in <code>docs/integrations/change-events.md</code>.
      </p>
      <FormError message={error} />

      <form className="card inline" onSubmit={create} aria-label="Create an integration">
        <Field label="Name" htmlFor="integration-name">
          <input id="integration-name" name="name" required maxLength={60} autoComplete="off" placeholder="prod-alertmanager" />
        </Field>
        <Field label="Integration type" htmlFor="integration-kind">
          <select id="integration-kind" name="kind" defaultValue="alertmanager">
            <option value="alertmanager">Alertmanager</option>
            <option value="change-events">Deployments / change events</option>
          </select>
        </Field>
        <button type="submit" className="btn">
          Create integration
        </button>
      </form>

      {revealed ? (
        <div className="card" role="status" data-testid="integration-secret">
          <p>
            <strong>{revealed.action === "created" ? "Integration created" : "Secret rotated"}: {revealed.name} ({revealed.kind}).</strong> Copy this token now. It is shown only
            once and <strong>cannot be retrieved later</strong>; if you lose it, rotate the secret to get a new one.
            {revealed.action === "rotated" ? " The previous token no longer works." : ""}
          </p>
          <code className="token" data-testid="integration-token">
            {revealed.token}
          </code>
          <button type="button" className="btn secondary" onClick={() => void copy(revealed.token)}>
            {copied ? "Token copied" : "Copy token"}
          </button>{" "}
          <button type="button" className="btn-link" onClick={() => setRevealed(null)}>
            I have saved it, hide
          </button>
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="muted">No integrations yet.</p>
      ) : (
        <table className="table">
          <caption className="visually-hidden">Organization integrations</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Last used</th>
              <th scope="col">Created</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td>
                <td>{i.kind === "alertmanager" ? "Alertmanager" : "Change events"}</td>
                <td>{i.status === "active" ? "Active" : `Revoked ${i.revokedAt ? relativeTime(i.revokedAt) : ""}`}</td>
                <td>{i.lastUsedAt ? relativeTime(i.lastUsedAt) : "Never"}</td>
                <td>
                  {relativeTime(i.createdAt)}
                  {i.createdBy ? ` by ${i.createdBy.displayName}` : ""}
                  {i.rotatedAt ? `, rotated ${relativeTime(i.rotatedAt)}` : ""}
                </td>
                <td>
                  {i.status === "active" ? (
                    <>
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => {
                          if (window.confirm(`Rotate the secret of "${i.name}"? The current token stops working immediately.`)) {
                            void act(async () => reveal(await api.rotateIntegration(i.id), "rotated"));
                          }
                        }}
                      >
                        Rotate secret
                      </button>{" "}
                      <button
                        type="button"
                        className="btn-link danger"
                        onClick={() => {
                          if (window.confirm(`Revoke "${i.name}"? Its token stops working immediately and cannot be restored.`)) {
                            void act(async () => {
                              await api.revokeIntegration(i.id);
                            });
                          }
                        }}
                      >
                        Revoke
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
