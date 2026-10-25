import {
  MAX_ACTIVE_INTEGRATIONS_PER_ORGANIZATION,
  createIntegrationSchema,
  uuidSchema,
  type CreatedIntegrationDto,
  type IntegrationDto,
} from "@platform/shared";
import type { AuthContext } from "../auth/auth.service";
import { generateToken, hashToken } from "../auth/tokens";
import { PG, conflict, notFound, pgCode, validationFailed } from "../common/errors";
import { authorize } from "../common/authz";
import type { Database, SqlClient } from "../common/sql";
import { iso } from "../common/sql-helpers";

const ACTIVE_NAME_INDEX = "integrations_org_active_name_key";

interface Row {
  id: string;
  kind: IntegrationDto["kind"];
  name: string;
  created_at: string;
  created_by: string | null;
  creator_name: string | null;
  rotated_at: string | null;
  rotated_by: string | null;
  rotator_name: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoker_name: string | null;
  last_used_at: string | null;
}

// NOTE: token_hash is deliberately not selected anywhere in this file except where it is written.
const SELECT_INTEGRATION = `
  SELECT i.id, i.kind, i.name,
         ${iso("i.created_at")} AS created_at, i.created_by, cu.display_name AS creator_name,
         ${iso("i.rotated_at")} AS rotated_at, i.rotated_by, ru.display_name AS rotator_name,
         ${iso("i.revoked_at")} AS revoked_at, i.revoked_by, vu.display_name AS revoker_name,
         ${iso("i.last_used_at")} AS last_used_at
    FROM integrations i
    LEFT JOIN users cu ON cu.id = i.created_by
    LEFT JOIN users ru ON ru.id = i.rotated_by
    LEFT JOIN users vu ON vu.id = i.revoked_by`;

const person = (id: string | null, name: string | null) => (id ? { id, displayName: name ?? "Unknown" } : null);

function toDto(r: Row): IntegrationDto {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    status: r.revoked_at ? "revoked" : "active",
    createdAt: r.created_at,
    createdBy: person(r.created_by, r.creator_name),
    rotatedAt: r.rotated_at,
    rotatedBy: person(r.rotated_by, r.rotator_name),
    revokedAt: r.revoked_at,
    revokedBy: person(r.revoked_by, r.revoker_name),
    lastUsedAt: r.last_used_at,
  };
}

/**
 * Management of integration credentials (create, list, rotate, revoke). Only organization admins and owners
 * (action "integration:manage"). The organization always comes from the authenticated session.
 *
 * The bearer token is generated here with the CSPRNG utility used for sessions and invitations (256 bits), only its
 * SHA-256 hash is stored, and the plaintext exists in exactly two return values: `create` and `rotate`.
 */
export class IntegrationService {
  constructor(private readonly db: Database) {}

  async list(auth: AuthContext): Promise<IntegrationDto[]> {
    const organizationId = authorize(auth, "integration:manage");
    const rows = await this.db.query<Row>(`${SELECT_INTEGRATION} WHERE i.organization_id = $1 ORDER BY i.created_at DESC, i.id`, [organizationId]);
    return rows.rows.map(toDto);
  }

  async create(auth: AuthContext, raw: unknown): Promise<CreatedIntegrationDto> {
    const organizationId = authorize(auth, "integration:manage");
    const parsed = createIntegrationSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const token = generateToken();

    try {
      const id = await this.db.tx(async (tx) => {
        // Serialises concurrent creations in one organization so the per-organization cap cannot be overshot.
        // FOR NO KEY UPDATE does not block membership foreign-key checks.
        await tx.query("SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE", [organizationId]);
        const count = await tx.query<{ n: string }>("SELECT count(*) AS n FROM integrations WHERE organization_id = $1 AND revoked_at IS NULL", [organizationId]);
        if (Number((count.rows[0] as { n: string }).n) >= MAX_ACTIVE_INTEGRATIONS_PER_ORGANIZATION) {
          throw conflict(`An organization can have at most ${MAX_ACTIVE_INTEGRATIONS_PER_ORGANIZATION} active integrations. Revoke one first.`);
        }
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO integrations (organization_id, kind, name, token_hash, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [organizationId, parsed.data.kind, parsed.data.name, hashToken(token), auth.userId],
        );
        return (inserted.rows[0] as { id: string }).id;
      });
      return { ...(await this.getOrThrow(this.db, organizationId, id)), token };
    } catch (error) {
      if (pgCode(error) === PG.uniqueViolation && (error as { constraint?: string }).constraint === ACTIVE_NAME_INDEX) {
        throw conflict("An active integration with this name already exists");
      }
      throw error;
    }
  }

  /**
   * Replaces the token hash IN PLACE: the integration id (the dedupe identity of every alert cycle) does not change,
   * and the previous token stops working as soon as this statement commits. A revoked integration cannot be rotated.
   */
  async rotate(auth: AuthContext, integrationId: string): Promise<CreatedIntegrationDto> {
    const organizationId = authorize(auth, "integration:manage");
    if (!uuidSchema.safeParse(integrationId).success) throw notFound("Integration");
    const token = generateToken();
    const updated = await this.db.query<{ id: string }>(
      `UPDATE integrations SET token_hash = $3, rotated_at = now(), rotated_by = $4
        WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL RETURNING id`,
      [integrationId, organizationId, hashToken(token), auth.userId],
    );
    if (updated.rows.length === 0) {
      const existing = await this.getOrThrow(this.db, organizationId, integrationId); // 404 when absent or in another organization
      throw conflict(`Integration "${existing.name}" is revoked and cannot be rotated. Create a new integration instead.`);
    }
    return { ...(await this.getOrThrow(this.db, organizationId, integrationId)), token };
  }

  /** Idempotent. Takes effect immediately: the next request with the token is rejected (see AlertIngestionService). */
  async revoke(auth: AuthContext, integrationId: string): Promise<IntegrationDto> {
    const organizationId = authorize(auth, "integration:manage");
    if (!uuidSchema.safeParse(integrationId).success) throw notFound("Integration");
    await this.db.query(
      `UPDATE integrations SET revoked_at = now(), revoked_by = $3
        WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL`,
      [integrationId, organizationId, auth.userId],
    );
    return this.getOrThrow(this.db, organizationId, integrationId);
  }

  private async getOrThrow(db: SqlClient, organizationId: string, integrationId: string): Promise<IntegrationDto> {
    const result = await db.query<Row>(`${SELECT_INTEGRATION} WHERE i.organization_id = $1 AND i.id = $2`, [organizationId, integrationId]);
    const row = result.rows[0];
    if (!row) throw notFound("Integration");
    return toDto(row);
  }
}
