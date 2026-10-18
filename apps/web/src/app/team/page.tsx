"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { canChangeRole, canRemoveMember, type MemberDto, type OrgRole } from "@platform/shared";
import { AppShell, useCan } from "../../components/shell";
import { AiSettingsPanel } from "../../components/ai-settings-panel";
import { IntegrationsPanel } from "../../components/integrations-panel";
import { Field, FormError } from "../../components/ui";
import type { CreatedInvite, InviteSummary } from "../../lib/api-client";
import { ROLE_LABEL, errorText, relativeTime } from "../../lib/format";
import { api, useSession } from "../../lib/session";

export default function TeamPage() {
  return (
    <AppShell>
      <Team />
    </AppShell>
  );
}

const ROLES: OrgRole[] = ["viewer", "responder", "admin", "owner"];

function Team() {
  const { state, refresh } = useSession();
  const canInvite = useCan("member:invite");
  const canManageIntegrations = useCan("integration:manage");
  const canConfigureAi = useCan("ai:configure");
  const me = state.status === "authenticated" ? state.me : null;
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copiedInvite, setCopiedInvite] = useState<"link" | "token" | null>(null);

  const load = useCallback(async () => {
    try {
      setMembers(await api.listMembers());
      setInvites(canInvite ? await api.listInvites() : []);
    } catch (e) {
      setError(errorText(e));
    }
  }, [canInvite]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(errorText(e));
      await load();
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(null);
    try {
      setCreated(await api.createInvite({ email: String(data.get("email")), role: String(data.get("role")) as InviteSummary["role"] }));
      form.reset();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function copyInviteText(value: string, kind: "link" | "token") {
    setError(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopiedInvite(kind);
    } catch {
      setError("Clipboard access failed. Please copy the displayed text manually.");
    }
  }

  return (
    <>
      <h1>Team</h1>
      <FormError message={error} />
      <table className="table">
        <caption className="visually-hidden">Organization members</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Joined</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const self = m.userId === me?.user.id;
            const roleOptions = me?.role ? ROLES.filter((r) => canChangeRole({ actorRole: me.role as OrgRole, actorIsTarget: self, targetRole: m.role, newRole: r })) : [];
            const removable = me?.role ? canRemoveMember({ actorRole: me.role, actorIsTarget: self, targetRole: m.role }) : false;
            return (
              <tr key={m.userId}>
                <td>
                  {m.displayName} {self ? <span className="muted">(you)</span> : null}
                </td>
                <td>{m.email}</td>
                <td>
                  {roleOptions.length > 0 ? (
                    <select
                      aria-label={`Role of ${m.displayName}`}
                      value={m.role}
                      onChange={(e) => void act(() => api.changeRole(m.userId, e.target.value as OrgRole))}
                    >
                      {[...new Set<OrgRole>([m.role, ...roleOptions])].map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    ROLE_LABEL[m.role]
                  )}
                </td>
                <td>{relativeTime(m.joinedAt)}</td>
                <td>
                  {removable ? (
                    <button
                      type="button"
                      className="btn-link danger"
                      onClick={() => {
                        if (window.confirm(`Remove ${m.displayName} from this organization?`)) {
                          void act(async () => {
                            await api.removeMember(m.userId);
                            if (self) await refresh();
                          });
                        }
                      }}
                    >
                      {self ? "Leave" : "Remove"}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {canInvite ? (
        <section aria-labelledby="invite-h">
          <h2 id="invite-h">Invite someone</h2>
          <form className="card inline" onSubmit={invite} aria-label="Invite a member">
            <Field label="Email" htmlFor="invite-email">
              <input id="invite-email" name="email" type="email" required />
            </Field>
            <Field label="Role" htmlFor="invite-role">
              <select id="invite-role" name="role" defaultValue="responder">
                <option value="viewer">Viewer</option>
                <option value="responder">Responder</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <button type="submit" className="btn">
              Create invitation
            </button>
          </form>
          {created ? (
            <div className="card" role="status">
              <p>
                Invitation for <strong>{created.email}</strong> created. Share this one-time registration link with them. New users join your
                organization directly without creating a separate organization. Existing users should sign in and accept the invitation below.
              </p>
              <code className="token" data-testid="invite-registration-link">
                {`${window.location.origin}/register#invite=${encodeURIComponent(created.token)}`}
              </code>
              <button
                type="button"
                className="btn secondary"
                onClick={() => void copyInviteText(
                  `${window.location.origin}/register#invite=${encodeURIComponent(created.token)}`,
                  "link"
                )}
              >
                {copiedInvite === "link" ? "Link copied" : "Copy link"}
              </button>
              <p className="muted">
                The link is shown once and works once, only for {created.email}. Prefer to paste the token instead? It is{" "}
                <code data-testid="invite-token">{created.token}</code>{" "}
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => void copyInviteText(created.token, "token")}
                >
                  {copiedInvite === "token" ? "Token copied" : "Copy token"}
                </button>
              </p>
            </div>
          ) : null}
          {invites.length > 0 ? (
            <ul className="plain">
              {invites.map((i) => (
                <li key={i.id}>
                  {i.email} · {ROLE_LABEL[i.role]} · expires {relativeTime(i.expiresAt)}{" "}
                  <button type="button" className="btn-link danger" onClick={() => void act(() => api.revokeInvite(i.id))}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {canManageIntegrations ? <IntegrationsPanel /> : null}
      {canConfigureAi ? <AiSettingsPanel /> : null}

      <AcceptInvite onAccepted={refresh} />
    </>
  );
}

function AcceptInvite({ onAccepted }: { onAccepted(): Promise<void> }) {
  const { setMe } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError(null);
    setDone(false);
    try {
      setMe(await api.acceptInvite(String(new FormData(form).get("token")).trim()));
      form.reset();
      setDone(true);
      await onAccepted();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section aria-labelledby="accept-h">
      <h2 id="accept-h">Accept an invitation</h2>
      <form className="card inline" onSubmit={submit} aria-label="Accept an invitation">
        <Field label="Invitation token" htmlFor="accept-token">
          <input id="accept-token" name="token" autoComplete="off" required />
        </Field>
        <button type="submit" className="btn secondary">
          Join organization
        </button>
      </form>
      <FormError message={error} />
      {done ? <p role="status">You joined the organization and it is now active.</p> : null}
    </section>
  );
}
