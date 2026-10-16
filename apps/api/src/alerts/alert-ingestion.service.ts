import type { AlertDeliveryItem, AlertDeliveryResult, AlertWebhookResponse } from "@platform/shared";
import { hashToken } from "../auth/tokens";
import { AppError, PG, pgCode, serviceUnavailable, unauthenticated } from "../common/errors";
import type { Database, SqlClient } from "../common/sql";
import type { IncidentService } from "../incidents/incident.service";
import type { ParsedAlert, ParsedDelivery } from "./alertmanager-payload";

/** The credential a request presented, after lookup. Never contains the plaintext token. */
export interface AuthenticatedIntegration {
  id: string;
  /** The ONLY source of the tenant for a webhook delivery. */
  organizationId: string;
  name: string;
  tokenHash: string;
}

interface CycleRow {
  id: string;
  /** NULL only for a resolved-before-firing tombstone, which deliberately has no incident. */
  incident_id: string | null;
  state: "firing" | "resolved";
  incident_number: string | number | null;
}

const LOCK_TIMEOUT = "5s";
/** last_used_at is a hint for operators, not an audit log: refresh it at most this often per integration. */
const LAST_USED_REFRESH_SECONDS = 60;

const bad = () => unauthenticated("Invalid or revoked credentials");

/**
 * Alertmanager webhook ingestion: credential validation and transactional alert-cycle deduplication.
 *
 * IDENTITY OF A CYCLE = (integration id, fingerprint, startsAt). The integration id is stable across token rotation.
 * `groupKey` is never used for identity: it names a group of alerts, not one alert.
 *
 * CONCURRENCY. One delivery = one transaction:
 *   1. SELECT ... FOR SHARE on the integration row, matching the presented token hash and `revoked_at IS NULL`.
 *      A revoke/rotate (an UPDATE of that row) therefore waits for in-flight deliveries to finish, and a delivery that
 *      starts after the revoke/rotate commits finds no row and is rejected. A completed revocation can never be
 *      followed by a successful delivery with the old token.
 *   2. pg_advisory_xact_lock per integration: deliveries of ONE integration are processed one at a time, which makes
 *      the check-then-insert below race-free and gives every transaction the same lock order (no deadlocks between
 *      overlapping batches, which would otherwise take the incident counter row in different orders).
 *   3. The UNIQUE constraint on (integration_id, fingerprint, starts_at) is the real guarantee: if a bug or a manual
 *      write ever lets a race through, the INSERT ... ON CONFLICT DO NOTHING returns no row, the transaction aborts
 *      (nothing is kept) and the sender retries safely.
 * The response is produced only after COMMIT, so a 2xx always means the database changes are durable; if the response
 * is lost the sender's retry hits the same cycle rows and is a no-op apart from counters.
 */
export class AlertIngestionService {
  constructor(
    private readonly db: Database,
    private readonly incidents: IncidentService,
  ) {}

  /** Cheap pre-check (one indexed lookup). The transaction in `ingest` validates the credential again. */
  async authenticate(token: string): Promise<AuthenticatedIntegration | null> {
    const tokenHash = hashToken(token);
    const found = await this.db.query<{ id: string; organization_id: string; name: string }>(
      "SELECT id, organization_id, name FROM integrations WHERE token_hash = $1 AND revoked_at IS NULL",
      [tokenHash],
    );
    const row = found.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, name: row.name, tokenHash } : null;
  }

  async ingest(integration: AuthenticatedIntegration, delivery: ParsedDelivery): Promise<AlertWebhookResponse> {
    const results = await this.db.tx(async (tx) => {
      await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      const valid = await tx.query(
        `SELECT 1 FROM integrations WHERE id = $1 AND organization_id = $2 AND token_hash = $3 AND revoked_at IS NULL FOR SHARE`,
        [integration.id, integration.organizationId, integration.tokenHash],
      );
      if (valid.rows.length === 0) throw bad();
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`alert-integration:${integration.id}`]);

      const items: AlertDeliveryItem[] = [];
      for (const alert of delivery.alerts) items.push(await this.processAlert(tx, integration, alert));
      return items;
    });
    await this.touchLastUsed(integration.id);
    return summarize(results);
  }

  private async processAlert(tx: SqlClient, integration: AuthenticatedIntegration, alert: ParsedAlert): Promise<AlertDeliveryItem> {
    const item = (result: AlertDeliveryResult, cycle?: { incidentId: string | null; incidentNumber: number | null; deliveryCount: number }): AlertDeliveryItem => ({
      fingerprint: alert.fingerprint,
      startsAt: alert.startsAt,
      result,
      incidentId: cycle?.incidentId ?? null,
      incidentNumber: cycle?.incidentNumber ?? null,
      deliveryCount: cycle?.deliveryCount ?? null,
    });

    const existing = await tx.query<CycleRow>(
      `SELECT c.id, c.incident_id, c.state, i.number AS incident_number
         FROM alert_cycles c
         LEFT JOIN incidents i ON i.organization_id = c.organization_id AND i.id = c.incident_id
        WHERE c.integration_id = $1 AND c.fingerprint = $2 AND c.starts_at = $3::timestamptz
          FOR UPDATE OF c`,
      [integration.id, alert.fingerprint, alert.startsAt],
    );
    const cycle = existing.rows[0];

    if (!cycle) {
      if (alert.status === "resolved") {
        // Persist a tombstone atomically with the delivery. Without it, a delayed firing for this same cycle would
        // see no row and create a phantom open incident. The per-integration transaction lock serializes this insert
        // with concurrent deliveries; the UNIQUE key remains the database-level idempotency backstop.
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO alert_cycles
             (organization_id, integration_id, fingerprint, starts_at, incident_id, state, delivery_count, resolved_at)
           VALUES ($1, $2, $3, $4::timestamptz, NULL, 'resolved', 1, now())
           ON CONFLICT (integration_id, fingerprint, starts_at) DO NOTHING
           RETURNING id`,
          [integration.organizationId, integration.id, alert.fingerprint, alert.startsAt],
        );
        if (inserted.rows.length === 0) {
          // Defensive backstop: unexpected conflict means our transaction's view did not match the unique key.
          // Roll back this delivery and ask Alertmanager to retry instead of acknowledging a possibly unprocessed state.
          throw serviceUnavailable(1, "A concurrent delivery for the same alert was in progress; retry");
        }
        return item("ignored_unknown_resolution", { incidentId: null, incidentNumber: null, deliveryCount: 1 });
      }

      const actor = { userId: null, displayName: `alertmanager: ${integration.name}`.slice(0, 80) };
      const created = await this.incidents.createFromAlert(tx, {
        organizationId: integration.organizationId,
        title: alert.title,
        description: alert.description,
        severity: alert.severity,
        actor,
        eventPayload: { source: "alertmanager", integrationId: integration.id, fingerprint: alert.fingerprint, startsAt: alert.startsAt },
      });
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO alert_cycles (organization_id, integration_id, fingerprint, starts_at, incident_id)
         VALUES ($1, $2, $3, $4::timestamptz, $5)
         ON CONFLICT (integration_id, fingerprint, starts_at) DO NOTHING
         RETURNING id`,
        [integration.organizationId, integration.id, alert.fingerprint, alert.startsAt, created.id],
      );
      // Cannot happen while the advisory lock is held; if it does, abort everything (incident included) and let the sender retry.
      if (inserted.rows.length === 0) throw serviceUnavailable(1, "A concurrent delivery for the same alert was in progress; retry");
      return item("created", { incidentId: created.id, incidentNumber: created.number, deliveryCount: 1 });
    }

    const incidentNumber = cycle.incident_number === null ? null : Number(cycle.incident_number);
    const known = (deliveryCount: number) => ({ incidentId: cycle.incident_id, incidentNumber, deliveryCount });

    if (alert.status === "firing") {
      // Repeated firing delivery. A cycle already resolved is NEVER reopened by a late or replayed firing notification.
      const count = await this.touch(tx, cycle.id);
      return item(cycle.state === "firing" ? "duplicate" : "ignored_stale_firing", known(count));
    }

    if (cycle.state === "resolved") return item("duplicate_resolved", known(await this.touch(tx, cycle.id)));

    // A firing cycle must always point to the incident created with it. Tombstones are resolved-only; fail closed
    // rather than passing a nullable reference into the lifecycle service if persisted state is inconsistent.
    if (cycle.incident_id === null) {
      throw new AppError("INTERNAL", "A firing alert cycle is missing its incident reference");
    }

    // firing -> resolved: the one meaningful transition. Resolves the incident through the lifecycle service.
    await this.incidents.resolveFromAlert(
      tx,
      integration.organizationId,
      cycle.incident_id,
      { userId: null, displayName: `alertmanager: ${integration.name}`.slice(0, 80) },
      { to: "resolved", note: "Resolved by Alertmanager", source: "alertmanager", integrationId: integration.id, fingerprint: alert.fingerprint },
    );
    const updated = await tx.query<{ delivery_count: number }>(
      `UPDATE alert_cycles SET state = 'resolved', resolved_at = now(), delivery_count = delivery_count + 1, last_seen_at = now()
        WHERE id = $1 RETURNING delivery_count`,
      [cycle.id],
    );
    return item("resolved", known(Number((updated.rows[0] as { delivery_count: number }).delivery_count)));
  }

  /** Counts a repeat delivery. Deliberately writes NO timeline entry: repeats are expected and would be noise. */
  private async touch(tx: SqlClient, cycleId: string): Promise<number> {
    const updated = await tx.query<{ delivery_count: number }>(
      "UPDATE alert_cycles SET delivery_count = delivery_count + 1, last_seen_at = now() WHERE id = $1 RETURNING delivery_count",
      [cycleId],
    );
    return Number((updated.rows[0] as { delivery_count: number }).delivery_count);
  }

  /** Best effort AFTER the commit and outside the transaction (it must not take a row lock that a revoke is waiting for). */
  private async touchLastUsed(integrationId: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE integrations SET last_used_at = now()
          WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - make_interval(secs => $2::int))`,
        [integrationId, LAST_USED_REFRESH_SECONDS],
      );
    } catch {
      // A failed hint update must never turn a committed delivery into an error response.
    }
  }
}

function summarize(results: AlertDeliveryItem[]): AlertWebhookResponse {
  const count = (...which: AlertDeliveryResult[]) => results.filter((r) => which.includes(r.result)).length;
  return {
    accepted: results.length,
    created: count("created"),
    resolved: count("resolved"),
    duplicates: count("duplicate", "duplicate_resolved", "ignored_stale_firing"),
    ignored: count("ignored_unknown_resolution"),
    results,
  };
}

const TRANSIENT_NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"]);
const TRANSIENT_MESSAGE = /timeout exceeded when trying to connect|connection terminated|the database system is (starting up|shutting down)|too many clients|connect ECONNREFUSED|server closed the connection/i;

/**
 * Turns a database/connection failure into a retryable 503. AppErrors (including 401) pass through unchanged; an error
 * that is not recognised as transient is returned as is (the exception filter makes it a generic 500, which
 * Alertmanager also retries, and logs it with its stack).
 */
export function toRetryableFailure(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const code = pgCode(error);
  const nodeCode = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  const transientSqlState =
    code !== undefined &&
    (code.startsWith("08") || // connection exception
      code.startsWith("53") || // insufficient resources
      code === "57P01" || code === "57P02" || code === "57P03" || // admin shutdown / crash / cannot connect now
      code === PG.serializationFailure || code === PG.deadlock || code === PG.lockNotAvailable || code === PG.queryCanceled);
  if (transientSqlState || TRANSIENT_NODE_CODES.has(nodeCode) || TRANSIENT_MESSAGE.test(message)) return serviceUnavailable(5);
  return error;
}
