import {
  acceptInviteSchema,
  canChangeRole,
  canRemoveMember,
  changeMemberRoleSchema,
  createInviteSchema,
  uuidSchema,
  type MemberDto,
  type OrgRole,
} from "@platform/shared";
import type { AuthContext } from "../auth/auth.service";
import { generateToken, hashToken } from "../auth/tokens";
import { PG, conflict, forbidden, notFound, pgCode, validationFailed } from "../common/errors";
import { authorize } from "../common/authz";
import type { Database } from "../common/sql";
import { iso } from "../common/sql-helpers";

export interface InviteDto {
  id: string;
  email: string;
  role: "viewer" | "responder" | "admin";
  createdAt: string;
  expiresAt: string;
}

export interface CreatedInvite extends InviteDto {
  /** Shown exactly once, to the admin who created the invitation. Only its hash is stored. */
  token: string;
}

export class OrganizationService {
  constructor(
    private readonly db: Database,
    private readonly inviteTtlSeconds: number,
  ) {}

  async listMembers(auth: AuthContext): Promise<MemberDto[]> {
    const organizationId = authorize(auth, "member:list");
    const rows = await this.db.query<{ user_id: string; email: string; display_name: string; role: OrgRole; joined_at: string }>(
      `SELECT m.user_id, u.email, u.display_name, m.role, ${iso("m.created_at")} AS joined_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 ORDER BY m.created_at, m.user_id`,
      [organizationId],
    );
    return rows.rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, joinedAt: r.joined_at }));
  }

  async createInvite(auth: AuthContext, raw: unknown): Promise<CreatedInvite> {
    const organizationId = authorize(auth, "member:invite");
    const parsed = createInviteSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const token = generateToken();
    const result = await this.db.query<{ id: string; created_at: string; expires_at: string }>(
      `INSERT INTO organization_invites (organization_id, email, role, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::int))
       RETURNING id, ${iso("created_at")} AS created_at, ${iso("expires_at")} AS expires_at`,
      [organizationId, parsed.data.email, parsed.data.role, hashToken(token), auth.userId, this.inviteTtlSeconds],
    );
    const row = result.rows[0] as { id: string; created_at: string; expires_at: string };
    return { id: row.id, email: parsed.data.email, role: parsed.data.role, createdAt: row.created_at, expiresAt: row.expires_at, token };
  }

  async listInvites(auth: AuthContext): Promise<InviteDto[]> {
    const organizationId = authorize(auth, "member:invite");
    const rows = await this.db.query<{ id: string; email: string; role: InviteDto["role"]; created_at: string; expires_at: string }>(
      `SELECT id, email, role, ${iso("created_at")} AS created_at, ${iso("expires_at")} AS expires_at
         FROM organization_invites
        WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC, id`,
      [organizationId],
    );
    return rows.rows.map((r) => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at }));
  }

  async revokeInvite(auth: AuthContext, inviteId: string): Promise<void> {
    const organizationId = authorize(auth, "member:invite");
    if (!uuidSchema.safeParse(inviteId).success) throw notFound("Invitation");
    const result = await this.db.query(
      `UPDATE organization_invites SET revoked_at = now()
        WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [inviteId, organizationId],
    );
    if (result.rows.length === 0) throw notFound("Invitation");
  }

  /**
   * Redeems an invitation for the logged-in user. Single use, bound to the invited email, and every failure looks
   * the same (404) so the endpoint cannot be used to probe which tokens or emails exist.
   */
  async acceptInvite(auth: AuthContext, raw: unknown): Promise<{ organizationId: string; role: OrgRole }> {
    const parsed = acceptInviteSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);

    return this.db.tx(async (tx) => {
      // FOR UPDATE: two simultaneous redemptions of one token serialise here; the loser finds it already accepted.
      const found = await tx.query<{ id: string; organization_id: string; email: string; role: "viewer" | "responder" | "admin" }>(
        `SELECT id, organization_id, email, role FROM organization_invites
          WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
        [hashToken(parsed.data.token)],
      );
      const invite = found.rows[0];
      if (!invite || invite.email !== auth.email) throw notFound("Invitation");

      try {
        await tx.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)", [
          invite.organization_id,
          auth.userId,
          invite.role,
        ]);
      } catch (error) {
        if (pgCode(error) === PG.uniqueViolation) throw conflict("You are already a member of this organization");
        throw error;
      }
      await tx.query("UPDATE organization_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1", [invite.id, auth.userId]);
      await tx.query("UPDATE auth_sessions SET organization_id = $1 WHERE id = $2", [invite.organization_id, auth.sessionId]);
      return { organizationId: invite.organization_id, role: invite.role };
    });
  }

  async changeRole(auth: AuthContext, targetUserId: string, raw: unknown): Promise<MemberDto> {
    const organizationId = authorize(auth, "member:setRole");
    if (!uuidSchema.safeParse(targetUserId).success) throw notFound("Member");
    const parsed = changeMemberRoleSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);

    const current = await this.db.query<{ role: OrgRole }>(
      "SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2",
      [organizationId, targetUserId],
    );
    const target = current.rows[0];
    if (!target) throw notFound("Member");
    if (!canChangeRole({ actorRole: auth.role as OrgRole, actorIsTarget: targetUserId === auth.userId, targetRole: target.role, newRole: parsed.data.role })) {
      throw forbidden("You cannot make this role change");
    }
    try {
      await this.db.query("UPDATE memberships SET role = $3 WHERE organization_id = $1 AND user_id = $2", [
        organizationId,
        targetUserId,
        parsed.data.role,
      ]);
    } catch (error) {
      if (pgCode(error) === PG.checkViolation) throw conflict("An organization must keep at least one owner");
      throw error;
    }
    const members = await this.listMembers(auth);
    return members.find((m) => m.userId === targetUserId) as MemberDto;
  }

  async removeMember(auth: AuthContext, targetUserId: string): Promise<void> {
    const organizationId = authorize(auth, "member:remove");
    if (!uuidSchema.safeParse(targetUserId).success) throw notFound("Member");

    try {
      await this.db.tx(async (tx) => {
        // Lock the membership first. Incident assignment takes KEY SHARE on this same row before it locks an
        // incident, so a concurrent assignment either commits before this removal (and is audited below) or
        // observes the deleted membership and fails. Keep this lock order consistent to avoid write-skew/races.
        const current = await tx.query<{ role: OrgRole; display_name: string }>(
          `SELECT m.role, u.display_name
             FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = $1 AND m.user_id = $2
            FOR UPDATE OF m`,
          [organizationId, targetUserId],
        );
        const target = current.rows[0];
        if (!target) throw notFound("Member");
        if (!canRemoveMember({ actorRole: auth.role as OrgRole, actorIsTarget: targetUserId === auth.userId, targetRole: target.role })) {
          throw forbidden("You cannot remove this member");
        }

        // Do not rely on the FK's ON DELETE SET NULL: that changes incident state without an audit event.
        // Unassign every affected incident and append its event inside this same transaction.
        const assigned = await tx.query<{ id: string }>(
          `SELECT id FROM incidents
            WHERE organization_id = $1 AND assignee_id = $2
            ORDER BY id FOR UPDATE`,
          [organizationId, targetUserId],
        );
        for (const row of assigned.rows) {
          const updated = await tx.query<{ id: string }>(
            `UPDATE incidents SET assignee_id = NULL
              WHERE organization_id = $1 AND id = $2 AND assignee_id = $3
              RETURNING id`,
            [organizationId, row.id, targetUserId],
          );
          if (updated.rows.length === 0) continue;
          await tx.query(
            `INSERT INTO incident_events (organization_id, incident_id, type, actor_id, actor_label, payload)
             VALUES ($1, $2, 'assigned', $3, $4, $5::jsonb)`,
            [
              organizationId,
              row.id,
              auth.userId,
              auth.displayName,
              JSON.stringify({ from: { id: targetUserId, displayName: target.display_name }, to: null, reason: "member_removed" }),
            ],
          );
        }

        await tx.query("DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2", [organizationId, targetUserId]);
      });
    } catch (error) {
      if (pgCode(error) === PG.checkViolation) throw conflict("An organization must keep at least one owner");
      throw error;
    }
  }
}

