"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { canChangeRole, canRemoveMember, type MemberDto, type OrgRole } from "@platform/shared";
import { AppShell, useCan } from "../../components/shell";
import { AiSettingsPanel } from "../../components/ai-settings-panel";
import { IntegrationsPanel } from "../../components/integrations-panel";
import { Avatar, Field, FormError, PageHeader } from "../../components/ui";
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
      <PageHeader title="Team and integrations">
        Who can respond, how alerts reach this workspace, and whether AI suggestions are on.
      </PageHeader>
      <div className="mt-lg" />
      <FormError message={error} />

      <div className="stack loose">
        <section className="panel flush" aria-labelledby="members-h">
          <h2 id="members-h" className="label" style={{ padding: "18px 20px 0" }}>
            Members
          </h2>
          <div className="table-wrap" style={{ border: 0, background: "none" }}>
            <table className="table">
              <caption className="visually-hidden">Organization members</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Joined</th>
                  <th scope="col" className="num">
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
                        <span className="ident">
                          <Avatar name={m.displayName} />
                          <span style={{ overflowWrap: "anywhere" }}>
                            {m.displayName} {self ? <span className="muted">(you)</span> : null}
                          </span>
                        </span>
                      </td>
                      <td style={{ overflowWrap: "anywhere" }}>{m.email}</td>
                      <td>
                        {roleOptions.length > 0 ? (
                          <label className="mini-select">
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
                          </label>
                        ) : (
                          <span className="chip plain">{ROLE_LABEL[m.role]}</span>
                        )}
                      </td>
                      <td>
                        <span className="mono dim" style={{ fontSize: 12 }}>
                          {relativeTime(m.joinedAt)}
                        </span>
                      </td>
                      <td className="actions-cell">
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
          </div>
        </section>

        {canInvite ? (
          <section className="panel roomy" aria-labelledby="invite-h">
            <h2 id="invite-h" className="label">
              Invite someone
            </h2>
            <form className="form-grid" onSubmit={invite} aria-label="Invite a member">
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
              <div className="reveal" role="status">
                <p>
                  Invitation for <strong>{created.email}</strong> created. Share this one-time registration link with them. New users join your
                  organization directly without creating a separate organization. Existing users should sign in and accept the invitation below.
                </p>
                <code className="token" data-testid="invite-registration-link">
                  {`${window.location.origin}/register#invite=${encodeURIComponent(created.token)}`}
                </code>
                <div className="actions">
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => void copyInviteText(`${window.location.origin}/register#invite=${encodeURIComponent(created.token)}`, "link")}
                  >
                    {copiedInvite === "link" ? "Link copied" : "Copy link"}
                  </button>
                </div>
                <p className="hint" style={{ marginTop: 12 }}>
                  The link is shown once and works once, only for {created.email}. Prefer to paste the token instead? It is{" "}
                  <code data-testid="invite-token">{created.token}</code>{" "}
                  <button type="button" className="btn-link" onClick={() => void copyInviteText(created.token, "token")}>
                    {copiedInvite === "token" ? "Token copied" : "Copy token"}
                  </button>
                </p>
              </div>
            ) : null}
            {invites.length > 0 ? (
              <div style={{ marginTop: 18 }}>
                <h3 className="label" style={{ marginBottom: 8 }}>
                  Pending invitations
                </h3>
                <ul className="plain stack" style={{ gap: 8 }}>
                  {invites.map((i) => (
                    <li key={i.id} className="well row-between" style={{ padding: "10px 14px" }}>
                      <span style={{ overflowWrap: "anywhere" }}>
                        {i.email} <span className="chip plain tiny">{ROLE_LABEL[i.role]}</span>{" "}
                        <span className="hint">· expires {relativeTime(i.expiresAt)}</span>
                      </span>
                      <button type="button" className="btn-link danger" onClick={() => void act(() => api.revokeInvite(i.id))}>
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}

        {canManageIntegrations ? <IntegrationsPanel /> : null}
        {canConfigureAi ? <AiSettingsPanel /> : null}

        <AcceptInvite onAccepted={refresh} />
      </div>
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
    <section aria-labelledby="accept-h" className="panel roomy">
      <h2 id="accept-h" className="label">
        Accept an invitation
      </h2>
      <p className="hint" style={{ marginBottom: 14 }}>
        Already have an account and received an invitation token? Paste it here to join that organization.
      </p>
      <form className="form-grid" onSubmit={submit} aria-label="Accept an invitation">
        <Field label="Invitation token" htmlFor="accept-token">
          <input id="accept-token" name="token" autoComplete="off" required />
        </Field>
        <button type="submit" className="btn secondary">
          Join organization
        </button>
      </form>
      <FormError message={error} />
      {done ? (
        <p role="status" className="notice ok" style={{ marginTop: 12 }}>
          You joined the organization and it is now active.
        </p>
      ) : null}
    </section>
  );
}
