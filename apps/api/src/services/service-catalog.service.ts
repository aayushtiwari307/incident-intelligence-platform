import {
  changeEventInputSchema,
  createServiceSchema,
  linkIncidentServiceSchema,
  updateServiceSchema,
  uuidSchema,
  type ChangeEventDto,
  type ChangeEventInput,
  type IncidentServiceContextDto,
  type ServiceDto,
} from "@platform/shared";
import type { AuthContext } from "../auth/auth.service";
import { authorize } from "../common/authz";
import { AppError, conflict, notFound, pgCode, rateLimited, validationFailed } from "../common/errors";
import type { Database } from "../common/sql";
import { iso } from "../common/sql-helpers";
import { hashToken } from "../auth/tokens";
import { SlidingWindowLimiter } from "../http/rate-limiter";
import { parseChangeTimestamp, CHANGE_CORRELATION_LABEL, CHANGE_CORRELATION_WINDOW_HOURS } from "./change-correlation";
export { CHANGE_CORRELATION_LABEL } from "./change-correlation";

interface ServiceRow { id: string; name: string; owner_team: string; tier: ServiceDto["tier"]; created_at: string; updated_at: string }
interface ChangeRow { id: string; service_id: string; service_name: string; source: string; external_id: string; version: string; actor: string; changed_at: string }
interface IntegrationRow { id: string; organization_id: string; name: string; token_hash: string }

const MAX_CHANGES_PER_CONTEXT = 20;
const MAX_INCIDENTS_NOTIFIED_PER_CHANGE = 25;
const CHANGE_WEBHOOK_LIMIT_PER_MINUTE = 120;

export function toServiceDto(row: ServiceRow): ServiceDto {
  return { id: row.id, name: row.name, ownerTeam: row.owner_team, tier: row.tier, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toChangeDto(row: ChangeRow): ChangeEventDto {
  return {
    id: row.id, serviceId: row.service_id, serviceName: row.service_name, source: row.source,
    externalId: row.external_id, version: row.version, actor: row.actor, changedAt: row.changed_at,
    correlationLabel: CHANGE_CORRELATION_LABEL,
  };
}

/** Tenant-scoped service catalog, incident linkage, change ingestion, and 24-hour correlation context. */
export class ServiceCatalogService {
  private readonly integrationLimiter = new SlidingWindowLimiter(CHANGE_WEBHOOK_LIMIT_PER_MINUTE, 60_000);
  private readonly ipLimiter = new SlidingWindowLimiter(CHANGE_WEBHOOK_LIMIT_PER_MINUTE * 2, 60_000);
  private readonly failedAuthLimiter = new SlidingWindowLimiter(20, 5 * 60_000);

  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  async list(auth: AuthContext): Promise<ServiceDto[]> {
    const org = authorize(auth, "incident:read");
    const rows = await this.db.query<ServiceRow>(
      `SELECT id, name, owner_team, tier, ${iso("created_at")} AS created_at, ${iso("updated_at")} AS updated_at
         FROM services WHERE organization_id = $1 ORDER BY lower(name), id`, [org]);
    return rows.rows.map(toServiceDto);
  }

  async create(auth: AuthContext, raw: unknown): Promise<ServiceDto> {
    const org = authorize(auth, "integration:manage");
    const parsed = createServiceSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    try {
      const inserted = await this.db.query<ServiceRow>(
        `INSERT INTO services (organization_id, name, owner_team, tier, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, owner_team, tier, ${iso("created_at")} AS created_at, ${iso("updated_at")} AS updated_at`,
        [org, parsed.data.name, parsed.data.ownerTeam, parsed.data.tier, auth.userId]);
      return toServiceDto(inserted.rows[0]!);
    } catch (error) {
      if (pgCode(error) === "23505") throw conflict("A service with that name already exists in this organization");
      throw error;
    }
  }

  async update(auth: AuthContext, serviceId: string, raw: unknown): Promise<ServiceDto> {
    const org = authorize(auth, "integration:manage");
    if (!uuidSchema.safeParse(serviceId).success) throw notFound("Service");
    const parsed = updateServiceSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const fields: string[] = [];
    const params: unknown[] = [serviceId, org];
    const map = { name: "name", ownerTeam: "owner_team", tier: "tier" } as const;
    for (const key of Object.keys(map) as Array<keyof typeof map>) {
      const value = parsed.data[key];
      if (value !== undefined) { params.push(value); fields.push(`${map[key]} = $${params.length}`); }
    }
    params.push(this.now().toISOString());
    fields.push(`updated_at = $${params.length}::timestamptz`);
    try {
      const result = await this.db.query<ServiceRow>(
        `UPDATE services SET ${fields.join(", ")} WHERE id = $1 AND organization_id = $2
         RETURNING id, name, owner_team, tier, ${iso("created_at")} AS created_at, ${iso("updated_at")} AS updated_at`, params);
      if (!result.rows[0]) throw notFound("Service");
      return toServiceDto(result.rows[0]);
    } catch (error) {
      if (pgCode(error) === "23505") throw conflict("A service with that name already exists in this organization");
      throw error;
    }
  }

  async remove(auth: AuthContext, serviceId: string): Promise<void> {
    const org = authorize(auth, "integration:manage");
    if (!uuidSchema.safeParse(serviceId).success) throw notFound("Service");
    await this.db.tx(async (tx) => {
      // Lock the parent before checking references. Concurrent change ingestion or incident linking must finish first,
      // preventing a delete from silently unlinking an incident or racing a new change event into the service.
      const found = await tx.query<{ id: string }>(
        "SELECT id FROM services WHERE organization_id = $1 AND id = $2 FOR UPDATE", [org, serviceId]);
      if (!found.rows.length) throw notFound("Service");
      const history = await tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM change_events WHERE organization_id = $1 AND service_id = $2", [org, serviceId]);
      if (Number(history.rows[0]?.n ?? 0) > 0) throw conflict("This service has change history and cannot be deleted. Rename it or retain it for audit context.");
      const linked = await tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM incidents WHERE organization_id = $1 AND service_id = $2", [org, serviceId]);
      if (Number(linked.rows[0]?.n ?? 0) > 0) throw conflict("This service is linked to incidents. Unlink it from every incident before deleting it.");
      const removed = await tx.query<{ id: string }>(
        "DELETE FROM services WHERE organization_id = $1 AND id = $2 RETURNING id", [org, serviceId]);
      if (!removed.rows.length) throw notFound("Service");
    });
  }

  async linkIncident(auth: AuthContext, incidentId: string, raw: unknown): Promise<ServiceDto | null> {
    const org = authorize(auth, "incident:update");
    if (!uuidSchema.safeParse(incidentId).success) throw notFound("Incident");
    const parsed = linkIncidentServiceSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    return this.db.tx(async (tx) => {
      // Lock the service before the incident (the same parent-first order used by remove). Without this order,
      // a concurrent delete can hold the service row while linkIncident holds the incident row, creating a deadlock
      // when the FK check needs a key-share lock on the service.
      let service: ServiceRow | undefined;
      if (parsed.data.serviceId) {
        const found = await tx.query<ServiceRow>(
          `SELECT id, name, owner_team, tier, ${iso("created_at")} AS created_at, ${iso("updated_at")} AS updated_at
             FROM services WHERE organization_id = $1 AND id = $2 FOR KEY SHARE`, [org, parsed.data.serviceId]);
        service = found.rows[0];
        if (!service) throw notFound("Service");
      }
      const incident = await tx.query<{ service_id: string | null }>(
        "SELECT service_id FROM incidents WHERE organization_id = $1 AND id = $2 FOR UPDATE", [org, incidentId]);
      if (!incident.rows.length) throw notFound("Incident");
      const previousId = incident.rows[0]!.service_id;
      if (previousId !== (service?.id ?? null)) {
        await tx.query("UPDATE incidents SET service_id = $3 WHERE organization_id = $1 AND id = $2", [org, incidentId, service?.id ?? null]);
        await tx.query(
          `INSERT INTO incident_events (organization_id, incident_id, type, actor_id, actor_label, payload)
           VALUES ($1, $2, 'edited', $3, $4, $5::jsonb)`,
          [org, incidentId, auth.userId, auth.displayName, JSON.stringify({ field: "service", fromServiceId: previousId, toServiceId: service?.id ?? null })]);
      }
      return service ? toServiceDto(service) : null;
    });
  }

  async incidentContext(auth: AuthContext, incidentId: string): Promise<IncidentServiceContextDto> {
    const org = authorize(auth, "incident:read");
    if (!uuidSchema.safeParse(incidentId).success) throw notFound("Incident");
    const incident = await this.db.query<{ service_id: string | null; service_name: string | null; owner_team: string | null; tier: ServiceDto["tier"] | null; service_created_at: string | null; service_updated_at: string | null }>(
      `SELECT i.service_id, s.name AS service_name, s.owner_team, s.tier,
              ${iso("s.created_at")} AS service_created_at, ${iso("s.updated_at")} AS service_updated_at
         FROM incidents i LEFT JOIN services s ON s.organization_id = i.organization_id AND s.id = i.service_id
        WHERE i.organization_id = $1 AND i.id = $2`, [org, incidentId]);
    const row = incident.rows[0];
    if (!row) throw notFound("Incident");
    const service = row.service_id && row.service_name && row.owner_team && row.tier && row.service_created_at && row.service_updated_at
      ? { id: row.service_id, name: row.service_name, owner_team: row.owner_team, tier: row.tier, created_at: row.service_created_at, updated_at: row.service_updated_at }
      : null;
    if (!service) return { service: null, changes: [], windowHours: CHANGE_CORRELATION_WINDOW_HOURS };
    const changes = await this.db.query<ChangeRow>(
      `SELECT c.id, c.service_id, s.name AS service_name, c.source, c.external_id, c.version, c.actor, ${iso("c.changed_at")} AS changed_at
         FROM change_events c JOIN services s ON s.organization_id = c.organization_id AND s.id = c.service_id
         JOIN incidents i ON i.organization_id = c.organization_id AND i.id = $2
        WHERE c.organization_id = $1 AND c.service_id = i.service_id
          AND c.changed_at <= i.created_at AND c.changed_at >= i.created_at - interval '${CHANGE_CORRELATION_WINDOW_HOURS} hours'
        ORDER BY c.changed_at DESC, c.id DESC LIMIT $3`, [org, incidentId, MAX_CHANGES_PER_CONTEXT]);
    return { service: toServiceDto(service), changes: changes.rows.map(toChangeDto), windowHours: CHANGE_CORRELATION_WINDOW_HOURS };
  }

  /** Handles change-event integration auth and commit. The raw bearer token never reaches logs or persistent storage. */
  async ingestChange(token: string, ip: string, readJson: () => Promise<unknown>): Promise<{ accepted: true; duplicate: boolean; changeEventId: string }> {
    const ipGate = this.ipLimiter.consume(ip);
    if (!ipGate.allowed) throw rateLimited(ipGate.retryAfterSeconds);
    if (!this.failedAuthLimiter.peek(ip).allowed) throw rateLimited(this.failedAuthLimiter.peek(ip).retryAfterSeconds);
    const credential = await this.lookupChangeIntegration(token);
    if (!credential) {
      this.failedAuthLimiter.consume(ip);
      throw new AppError("UNAUTHENTICATED", "Invalid or revoked change-event credentials", { headers: { "WWW-Authenticate": 'Bearer realm="change-events"' } });
    }
    const integrationGate = this.integrationLimiter.consume(credential.id);
    if (!integrationGate.allowed) throw new AppError("SERVICE_UNAVAILABLE", "Too many requests; retry after the indicated delay", { headers: { "Retry-After": String(integrationGate.retryAfterSeconds) } });
    const raw = await readJson();
    const parsed = changeEventInputSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const input: ChangeEventInput = parsed.data;
    const changedAt = parseChangeTimestamp(input.timestamp, this.now());
    if (!changedAt) {
      throw new AppError("VALIDATION_FAILED", "timestamp must be a real RFC 3339 timestamp within the last 30 days and no more than 5 minutes in the future");
    }
    const timestampIso = changedAt.toISOString();

    try {
      const accepted = await this.db.tx(async (tx) => {
        const valid = await tx.query(
          `SELECT 1 FROM integrations WHERE id = $1 AND organization_id = $2 AND token_hash = $3
             AND kind = 'change-events' AND revoked_at IS NULL FOR SHARE`,
          [credential.id, credential.organization_id, credential.token_hash]);
        if (!valid.rows.length) throw new AppError("UNAUTHENTICATED", "Invalid or revoked change-event credentials");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`change-integration:${credential.id}`]);
        const already = await tx.query<{ id: string }>(
          "SELECT id FROM change_events WHERE organization_id = $1 AND source = $2 AND external_id = $3",
          [credential.organization_id, input.source, input.externalId]);
        if (already.rows[0]) return { accepted: true as const, duplicate: true, changeEventId: already.rows[0].id };
        const service = await tx.query<{ id: string }>(
          "SELECT id FROM services WHERE organization_id = $1 AND lower(name) = lower($2)", [credential.organization_id, input.service]);
        if (!service.rows[0]) throw notFound("Service for this integration");
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO change_events (organization_id, service_id, source, external_id, version, actor, changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
           ON CONFLICT (organization_id, source, external_id) DO NOTHING RETURNING id`,
          [credential.organization_id, service.rows[0].id, input.source, input.externalId, input.version, input.actor, timestampIso]);
        const eventId = inserted.rows[0]?.id;
        if (!eventId) {
          const duplicate = await tx.query<{ id: string }>("SELECT id FROM change_events WHERE organization_id = $1 AND source = $2 AND external_id = $3", [credential.organization_id, input.source, input.externalId]);
          if (!duplicate.rows[0]) throw new AppError("SERVICE_UNAVAILABLE", "Could not confirm the change-event idempotency result");
          return { accepted: true as const, duplicate: true, changeEventId: duplicate.rows[0].id };
        }
        const incidents = await tx.query<{ id: string }>(
          `SELECT id FROM incidents WHERE organization_id = $1 AND service_id = $2
             AND created_at >= $3::timestamptz AND created_at <= $3::timestamptz + interval '${CHANGE_CORRELATION_WINDOW_HOURS} hours'
           ORDER BY created_at DESC LIMIT $4`,
          [credential.organization_id, service.rows[0].id, timestampIso, MAX_INCIDENTS_NOTIFIED_PER_CHANGE]);
        for (const incident of incidents.rows) {
          await tx.query(
            `INSERT INTO incident_events (organization_id, incident_id, type, actor_id, actor_label, payload)
             VALUES ($1, $2, 'change_context', NULL, $3, $4::jsonb)`,
            [credential.organization_id, incident.id, `change-event: ${input.source}`.slice(0, 80), JSON.stringify({ changeEventId: eventId })]);
        }
        return { accepted: true as const, duplicate: false, changeEventId: eventId };
      });
      await this.touchLastUsed(credential.id);
      return accepted;
    } catch (error) {
      if (pgCode(error) === "23503") throw notFound("Service for this integration");
      throw error;
    }
  }

  /** Best-effort operator hint, updated after commit and outside the credential lock. */
  private async touchLastUsed(integrationId: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE integrations SET last_used_at = now()
          WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
        [integrationId],
      );
    } catch {
      // A failed hint update must never turn a committed change event into a retry/error response.
    }
  }

  private async lookupChangeIntegration(token: string): Promise<IntegrationRow | null> {
    const found = await this.db.query<IntegrationRow>(
      `SELECT id, organization_id, name, token_hash FROM integrations
        WHERE token_hash = $1 AND kind = 'change-events' AND revoked_at IS NULL`, [hashToken(token)]);
    return found.rows[0] ?? null;
  }
}
