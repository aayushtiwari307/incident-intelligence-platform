import assert from "node:assert/strict";
import { AppError } from "../common/errors";
import { Database, type PoolLike, type PooledClient } from "../common/sql";
import { IncidentService } from "../incidents/incident.service";
import { AlertIngestionService, type AuthenticatedIntegration } from "./alert-ingestion.service";
import type { ParsedDelivery } from "./alertmanager-payload";

describe("AlertIngestionService", () => {
  it("fails closed when a firing cycle has no incident reference", async () => {
    const statements: string[] = [];
    let poolQueries = 0;
    const client: PooledClient = {
      async query<T>(text: string): Promise<{ rows: T[] }> {
        statements.push(text);
        if (text.startsWith("SELECT 1 FROM integrations")) return { rows: [{ valid: true } as T] };
        if (text.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
        if (text.includes("FROM alert_cycles c")) {
          return {
            rows: [{ id: "cycle-id", incident_id: null, state: "firing", incident_number: null } as T],
          };
        }
        return { rows: [] };
      },
      release() {},
    };
    const pool: PoolLike = {
      async query<T>(): Promise<{ rows: T[] }> {
        poolQueries += 1;
        return { rows: [] };
      },
      async connect() {
        return client;
      },
      async end() {},
    };
    const db = new Database(pool);

    class TrackingIncidentService extends IncidentService {
      resolveCalls = 0;

      override async resolveFromAlert(): Promise<"resolved"> {
        this.resolveCalls += 1;
        return "resolved";
      }
    }

    const incidents = new TrackingIncidentService(db);
    const service = new AlertIngestionService(db, incidents);
    const integration: AuthenticatedIntegration = {
      id: "integration-id",
      organizationId: "organization-id",
      name: "test",
      tokenHash: "token-hash",
    };
    const delivery: ParsedDelivery = {
      alerts: [{
        status: "resolved",
        fingerprint: "test-fingerprint",
        startsAt: "2026-10-15T10:00:00.000000Z",
        endsAt: "2026-10-15T10:01:00.000000Z",
        severity: "sev3",
        title: "Test alert",
        description: "",
      }],
    };

    await assert.rejects(
      service.ingest(integration, delivery),
      (error: unknown) => error instanceof AppError && error.code === "INTERNAL",
    );
    assert.equal(incidents.resolveCalls, 0, "no incident is passed to the lifecycle service");
    assert.ok(statements.includes("ROLLBACK"));
    assert.ok(!statements.includes("COMMIT"));
    assert.equal(poolQueries, 0, "last_used_at is not touched after the failed transaction");
  });
});
