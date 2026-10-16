import {
  canTransition,
  commentSchema,
  createIncidentSchema,
  incidentListQuerySchema,
  INCIDENT_TRANSITIONS,
  timelineQuerySchema,
  transitionIncidentSchema,
  updateIncidentSchema,
  uuidSchema,
  type IncidentDto,
  type IncidentEventDto,
  type IncidentEventType,
  type IncidentListDto,
  type IncidentRealtimeMessage,
} from "@platform/shared";
import type { AuthContext } from "../auth/auth.service";
import { AppError, PG, notFound, pgCode, validationFailed } from "../common/errors";
import { authorize } from "../common/authz";
import type { Database, SqlClient } from "../common/sql";
import { iso, jsonObject, num } from "../common/sql-helpers";

interface IncidentRow {
  id: string;
  number: string | number;
  title: string;
  description: string;
  severity: IncidentDto["severity"];
  status: IncidentDto["status"];
  version: string | number;
  assignee_id: string | null;
  assignee_name: string | null;
  created_by: string | null;
  creator_name: string | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  mitigated_at: string | null;
  resolved_at: string | null;
}

const SELECT_INCIDENT = `
  SELECT i.id, i.number, i.title, i.description, i.severity, i.status, i.version,
         i.assignee_id, au.display_name AS assignee_name, i.created_by, cu.display_name AS creator_name,
         ${iso("i.created_at")} AS created_at, ${iso("i.updated_at")} AS updated_at,
         ${iso("i.acknowledged_at")} AS acknowledged_at, ${iso("i.mitigated_at")} AS mitigated_at,
         ${iso("i.resolved_at")} AS resolved_at
    FROM incidents i
    LEFT JOIN users au ON au.id = i.assignee_id
    LEFT JOIN users cu ON cu.id = i.created_by`;

function toDto(r: IncidentRow): IncidentDto {
  return {
    id: r.id,
    number: num(r.number),
    title: r.title,
    description: r.description,
    severity: r.severity,
    status: r.status,
    assignee: r.assignee_id ? { id: r.assignee_id, displayName: r.assignee_name ?? "Unknown" } : null,
    createdBy: r.created_by ? { id: r.created_by, displayName: r.creator_name ?? "Unknown" } : null,
    version: num(r.version),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    acknowledgedAt: r.acknowledged_at,
    mitigatedAt: r.mitigated_at,
    resolvedAt: r.resolved_at,
  };
}

interface EventRow {
  id: string | number;
  type: IncidentEventType;
  actor_id: string | null;
  actor_label: string;
  payload: unknown;
  created_at: string;
}

const toEventDto = (r: EventRow): IncidentEventDto => ({
  id: num(r.id),
  type: r.type,
  actor: { id: r.actor_id, label: r.actor_label },
  payload: jsonObject(r.payload),
  createdAt: r.created_at,
});

const ASSIGNEE_FK = "incidents_assignee_membership_fkey";

/** Who an audit entry is attributed to. An AuthContext satisfies it; automation uses a null userId and a descriptive label. */
export interface Actor {
  userId: string | null;
  displayName: string;
}

export interface AlertIncidentInput {
  organizationId: string;
  title: string;
  description: string;
  severity: IncidentDto["severity"];
  actor: Actor;
  /** Extra, already-bounded keys for the "created" timeline entry (e.g. source, fingerprint). */
  eventPayload: Record<string, unknown>;
}

function assigneeNotMember(): AppError {
  return new AppError("VALIDATION_FAILED", "The assignee must be a member of this organization", {
    details: [{ path: "assigneeId", message: "Must be a member of this organization" }],
  });
}

export class IncidentService {
  constructor(
    private readonly db: Database,
    /** Runs inside the creating transaction (used to enqueue the AI analysis job atomically with the incident). */
    private readonly afterCreate?: (tx: SqlClient, info: { organizationId: string; incidentId: string; version: number; createdBy: string }) => Promise<void>,
  ) {}

  async create(auth: AuthContext, raw: unknown): Promise<IncidentDto> {
    const organizationId = authorize(auth, "incident:create");
    const parsed = createIncidentSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const input = parsed.data;

    try {
      const id = await this.db.tx(async (tx) => {
        const { id: incidentId, number } = await this.insertIncident(tx, {
          organizationId,
          title: input.title,
          description: input.description,
          severity: input.severity,
          assigneeId: input.assigneeId ?? null,
          createdBy: auth.userId,
        });
        await this.addEvent(tx, organizationId, incidentId, "created", auth, {
          number,
          title: input.title,
          severity: input.severity,
        });
        if (input.assigneeId) {
          await this.addEvent(tx, organizationId, incidentId, "assigned", auth, {
            from: null,
            to: await this.userSnapshot(tx, input.assigneeId),
          });
        }
        await this.afterCreate?.(tx, { organizationId, incidentId, version: 1, createdBy: auth.userId });
        return incidentId;
      });
      return await this.getOrThrow(this.db, organizationId, id);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async list(auth: AuthContext, raw: unknown): Promise<IncidentListDto> {
    const organizationId = authorize(auth, "incident:read");
    const parsed = incidentListQuerySchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const q = parsed.data;

    const where = ["i.organization_id = $1"];
    const params: unknown[] = [organizationId];
    const add = (clause: (placeholder: string) => string, value: unknown) => {
      params.push(value);
      where.push(clause(`$${params.length}`));
    };
    if (q.status) add((p) => `i.status = ${p}`, q.status);
    if (q.severity) add((p) => `i.severity = ${p}`, q.severity);
    if (q.assignee === "me") add((p) => `i.assignee_id = ${p}`, auth.userId);
    else if (q.assignee === "unassigned") where.push("i.assignee_id IS NULL");
    else if (q.assignee) add((p) => `i.assignee_id = ${p}`, q.assignee);
    if (q.cursor !== undefined) {
      if (!/^[1-9][0-9]{0,9}$/.test(q.cursor)) throw validationFailed(this.badCursor());
      add((p) => `i.number < ${p}`, Number(q.cursor));
    }
    params.push(q.limit + 1);

    const rows = await this.db.query<IncidentRow>(
      `${SELECT_INCIDENT} WHERE ${where.join(" AND ")} ORDER BY i.number DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.rows.slice(0, q.limit).map(toDto);
    const hasMore = rows.rows.length > q.limit;
    return { items: page, nextCursor: hasMore ? String((page[page.length - 1] as IncidentDto).number) : null };
  }

  async get(auth: AuthContext, incidentId: string): Promise<IncidentDto> {
    const organizationId = authorize(auth, "incident:read");
    return this.getOrThrow(this.db, organizationId, incidentId);
  }

  async update(auth: AuthContext, incidentId: string, raw: unknown): Promise<IncidentDto> {
    const organizationId = authorize(auth, "incident:update");
    const parsed = updateIncidentSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const input = parsed.data;

    try {
      await this.db.tx(async (tx) => {
        // Take a key-share lock on a requested assignee before the incident row. Member removal takes an
        // exclusive lock on the same membership before locking affected incidents; matching lock order makes
        // assignment and removal serializable with respect to each other.
        if (input.assigneeId) {
          const member = await tx.query(
            "SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR KEY SHARE",
            [organizationId, input.assigneeId],
          );
          if (member.rows.length === 0) throw assigneeNotMember();
        }
        const current = await this.lock(tx, organizationId, incidentId);
        this.assertVersion(current, input.expectedVersion);

        const sets: string[] = [];
        const params: unknown[] = [incidentId, organizationId];
        const set = (column: string, value: unknown) => {
          params.push(value);
          sets.push(`${column} = $${params.length}`);
        };
        const events: Array<[IncidentEventType, Record<string, unknown>]> = [];

        if (input.title !== undefined && input.title !== current.title) {
          set("title", input.title);
          events.push(["edited", { field: "title", from: current.title, to: input.title }]);
        }
        if (input.description !== undefined && input.description !== current.description) {
          set("description", input.description);
          events.push(["edited", { field: "description" }]);
        }
        if (input.severity !== undefined && input.severity !== current.severity) {
          set("severity", input.severity);
          events.push(["severity_changed", { from: current.severity, to: input.severity }]);
        }
        if (input.assigneeId !== undefined && input.assigneeId !== current.assignee_id) {
          set("assignee_id", input.assigneeId);
          events.push([
            "assigned",
            {
              from: current.assignee_id ? await this.userSnapshot(tx, current.assignee_id) : null,
              to: input.assigneeId ? await this.userSnapshot(tx, input.assigneeId) : null,
            },
          ]);
        }
        if (sets.length === 0) return; // nothing actually changes: no version bump, no event

        await tx.query(`UPDATE incidents SET ${sets.join(", ")} WHERE id = $1 AND organization_id = $2`, params);
        for (const [type, payload] of events) await this.addEvent(tx, organizationId, incidentId, type, auth, payload);
      });
      return await this.getOrThrow(this.db, organizationId, incidentId);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async transition(auth: AuthContext, incidentId: string, raw: unknown): Promise<IncidentDto> {
    const organizationId = authorize(auth, "incident:transition");
    const parsed = transitionIncidentSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const { to, expectedVersion, note } = parsed.data;

    try {
      await this.db.tx(async (tx) => {
        const current = await this.lock(tx, organizationId, incidentId);
        this.assertVersion(current, expectedVersion);
        await this.changeStatus(tx, organizationId, incidentId, current.status, to, auth, note ? { note } : {});
      });
      return await this.getOrThrow(this.db, organizationId, incidentId);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async comment(auth: AuthContext, incidentId: string, raw: unknown): Promise<IncidentEventDto> {
    const organizationId = authorize(auth, "incident:comment");
    const parsed = commentSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);

    return this.db.tx(async (tx) => {
      await this.lock(tx, organizationId, incidentId, "FOR SHARE");
      const id = await this.addEvent(tx, organizationId, incidentId, "comment", auth, { body: parsed.data.body });
      const event = await this.events(tx, organizationId, incidentId, id - 1, 1);
      return event[0] as IncidentEventDto;
    });
  }

  async timeline(auth: AuthContext, incidentId: string, raw: unknown): Promise<IncidentEventDto[]> {
    const organizationId = authorize(auth, "incident:read");
    const parsed = timelineQuerySchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    await this.getOrThrow(this.db, organizationId, incidentId); // 404 for other organizations' incidents
    return this.events(this.db, organizationId, incidentId, parsed.data.after, parsed.data.limit);
  }

  /**
   * SYSTEM write used by alert ingestion, inside the caller's transaction (the caller owns the dedupe mapping, so the
   * incident, its "created" entry and the mapping commit or roll back together). No AuthContext exists for an
   * external sender: the organization comes from the validated integration record, `created_by` is NULL and the audit
   * entry is attributed to the integration. AI analysis is not queued for these incidents; a responder can request it.
   */
  async createFromAlert(tx: SqlClient, input: AlertIncidentInput): Promise<{ id: string; number: number }> {
    const { id, number } = await this.insertIncident(tx, {
      organizationId: input.organizationId,
      title: input.title,
      description: input.description,
      severity: input.severity,
      assigneeId: null,
      createdBy: null,
    });
    await this.addEvent(tx, input.organizationId, id, "created", input.actor, {
      number,
      title: input.title,
      severity: input.severity,
      ...input.eventPayload,
    });
    return { id, number };
  }

  /**
   * SYSTEM write: resolves the incident of a resolved alert through the same status machinery as a human transition
   * (row lock, legal-transition check, timestamps, append-only timeline entry). An incident that is already resolved
   * is left untouched ("already_resolved"): no event, no version bump.
   */
  async resolveFromAlert(tx: SqlClient, organizationId: string, incidentId: string, actor: Actor, payload: Record<string, unknown>): Promise<"resolved" | "already_resolved"> {
    const current = await this.lock(tx, organizationId, incidentId);
    if (current.status === "resolved") return "already_resolved";
    await this.changeStatus(tx, organizationId, incidentId, current.status, "resolved", actor, payload);
    return "resolved";
  }

  /**
   * SYSTEM read for real-time delivery (there is no caller: authorization happened when each connection was accepted
   * and is re-checked while it lives). The organization is part of every filter, so a notification can never make this
   * return another organization's data. Null when the entry or its incident no longer exists.
   */
  async loadRealtimeMessage(organizationId: string, eventId: number): Promise<IncidentRealtimeMessage | null> {
    const found = await this.db.query<EventRow & { incident_id: string }>(
      `SELECT incident_id, id, type, actor_id, actor_label, payload, ${iso("created_at")} AS created_at
         FROM incident_events WHERE organization_id = $1 AND id = $2`,
      [organizationId, eventId],
    );
    const row = found.rows[0];
    if (!row) return null;
    const incident = await this.db.query<IncidentRow>(`${SELECT_INCIDENT} WHERE i.organization_id = $1 AND i.id = $2`, [organizationId, row.incident_id]);
    const incidentRow = incident.rows[0];
    if (!incidentRow) return null;
    return { eventId: num(row.id), incidentId: row.incident_id, event: toEventDto(row), incident: toDto(incidentRow) };
  }

  // ---------------------------------------------------------------------------------------------

  /** Locks the row. Always filtered by organization: another tenant's incident id is indistinguishable from a missing one. */
  private async lock(tx: SqlClient, organizationId: string, incidentId: string, mode = "FOR UPDATE") {
    if (!uuidSchema.safeParse(incidentId).success) throw notFound("Incident");
    const found = await tx.query<{ version: string | number; status: IncidentDto["status"]; title: string; description: string; severity: IncidentDto["severity"]; assignee_id: string | null }>(
      `SELECT version, status, title, description, severity, assignee_id FROM incidents WHERE id = $1 AND organization_id = $2 ${mode}`,
      [incidentId, organizationId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Incident");
    return { ...row, version: num(row.version) };
  }

  private assertVersion(current: { version: number }, expected: number): void {
    if (current.version !== expected) {
      throw new AppError("VERSION_CONFLICT", "The incident was changed by someone else. Reload and try again.", {
        details: { currentVersion: current.version },
      });
    }
  }

  private async getOrThrow(db: SqlClient, organizationId: string, incidentId: string): Promise<IncidentDto> {
    if (!uuidSchema.safeParse(incidentId).success) throw notFound("Incident");
    const result = await db.query<IncidentRow>(`${SELECT_INCIDENT} WHERE i.organization_id = $1 AND i.id = $2`, [organizationId, incidentId]);
    const row = result.rows[0];
    if (!row) throw notFound("Incident");
    return toDto(row);
  }

  /** Atomic per-organization counter + insert. Concurrent creations serialise on the counter row and get distinct numbers. */
  private async insertIncident(
    tx: SqlClient,
    i: { organizationId: string; title: string; description: string; severity: IncidentDto["severity"]; assigneeId: string | null; createdBy: string | null },
  ): Promise<{ id: string; number: number }> {
    const counter = await tx.query<{ last_number: string | number }>(
      `INSERT INTO incident_counters (organization_id, last_number) VALUES ($1, 1)
       ON CONFLICT (organization_id) DO UPDATE SET last_number = incident_counters.last_number + 1
       RETURNING last_number`,
      [i.organizationId],
    );
    const number = num((counter.rows[0] as { last_number: string | number }).last_number);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO incidents (organization_id, number, title, description, severity, assignee_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [i.organizationId, number, i.title, i.description, i.severity, i.assigneeId, i.createdBy],
    );
    return { id: (inserted.rows[0] as { id: string }).id, number };
  }

  /** The single place that applies a status change: legality check, timestamps, and the timeline entry. Caller holds the row lock. */
  private async changeStatus(
    tx: SqlClient,
    organizationId: string,
    incidentId: string,
    from: IncidentDto["status"],
    to: IncidentDto["status"],
    actor: Actor,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (!canTransition(from, to)) {
      throw new AppError("INVALID_TRANSITION", `Cannot move an incident from ${from} to ${to}`, {
        details: { from, to, allowed: INCIDENT_TRANSITIONS[from] },
      });
    }
    // Timestamps follow the status. Leaving "resolved" must clear resolved_at (a database CHECK requires it).
    const sets = ["status = $3"];
    if (from === "triggered") sets.push("acknowledged_at = COALESCE(acknowledged_at, now())");
    if (to === "mitigated") sets.push("mitigated_at = now()");
    if (to === "resolved") sets.push("resolved_at = now()");
    if (from === "resolved") sets.push("resolved_at = NULL");
    if (to === "investigating") sets.push("mitigated_at = NULL");
    await tx.query(`UPDATE incidents SET ${sets.join(", ")} WHERE id = $1 AND organization_id = $2`, [incidentId, organizationId, to]);
    await this.addEvent(tx, organizationId, incidentId, "status_changed", actor, { from, to, ...extra });
  }

  private async addEvent(
    tx: SqlClient,
    organizationId: string,
    incidentId: string,
    type: IncidentEventType,
    actor: Actor,
    payload: Record<string, unknown>,
  ): Promise<number> {
    const result = await tx.query<{ id: string | number }>(
      `INSERT INTO incident_events (organization_id, incident_id, type, actor_id, actor_label, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [organizationId, incidentId, type, actor.userId, actor.displayName, JSON.stringify(payload)],
    );
    return num((result.rows[0] as { id: string | number }).id);
  }

  private async events(db: SqlClient, organizationId: string, incidentId: string, after: number, limit: number): Promise<IncidentEventDto[]> {
    const rows = await db.query<EventRow>(
      `SELECT id, type, actor_id, actor_label, payload, ${iso("created_at")} AS created_at
         FROM incident_events WHERE organization_id = $1 AND incident_id = $2 AND id > $3 ORDER BY id LIMIT $4`,
      [organizationId, incidentId, after, limit],
    );
    return rows.rows.map(toEventDto);
  }

  private async userSnapshot(tx: SqlClient, userId: string): Promise<{ id: string; displayName: string }> {
    const r = await tx.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [userId]);
    return { id: userId, displayName: r.rows[0]?.display_name ?? "Unknown" };
  }

  private translate(error: unknown): unknown {
    if (pgCode(error) === PG.foreignKeyViolation && (error as { constraint?: string }).constraint === ASSIGNEE_FK) return assigneeNotMember();
    return error;
  }

  private badCursor() {
    return { issues: [{ path: ["cursor"], message: "Invalid cursor" }] } as unknown as Parameters<typeof validationFailed>[0];
  }
}

