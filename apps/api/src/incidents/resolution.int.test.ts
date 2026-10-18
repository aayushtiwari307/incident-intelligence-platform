import assert from "node:assert/strict";
import { AppError } from "../common/errors";
import { createTestApp, type TestApp } from "../test-support/app-harness";

const INCIDENT = { title: "Payments unavailable", description: "Checkout errors", severity: "sev2" } as const;
const RESOLUTION = { rootCause: "Connection pool exhaustion", fixApplied: "Raised pool capacity and added alerts" } as const;

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

async function concurrentPair(
  left: () => Promise<unknown>,
  right: () => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = async (run: () => Promise<unknown>) => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await gate;
    return run();
  };
  return Promise.allSettled([start(left), start(right)]);
}

describe("incident resolutions (real PostgreSQL)", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("creates at version 1, edits with an audit event, conflicts on duplicates and stale versions", async () => {
    const owner = await app.register("resolution-owner@example.com");
    const incident = await app.incidents.create(owner.auth, INCIDENT);
    const created = await app.incidents.createResolution(owner.auth, incident.id, RESOLUTION);
    assert.equal(created.incidentId, incident.id);
    assert.equal(created.rootCause, RESOLUTION.rootCause);
    assert.equal(created.fixApplied, RESOLUTION.fixApplied);
    assert.equal(created.resolvedBy, owner.me.user.id);
    assert.equal(created.version, 1);
    assert.ok(created.createdAt);
    assert.ok(created.updatedAt);

    const duplicate = await appError(app.incidents.createResolution(owner.auth, incident.id, RESOLUTION));
    assert.equal(duplicate.code, "CONFLICT");
    const updated = await app.incidents.updateResolution(owner.auth, incident.id, {
      expectedVersion: 1,
      rootCause: "Deployment exhausted the connection pool",
      fixApplied: "Rolled back deployment and added pool alerts",
    });
    assert.equal(updated.version, 2);
    assert.notEqual(updated.updatedAt, created.updatedAt);

    const stale = await appError(
      app.incidents.updateResolution(owner.auth, incident.id, { expectedVersion: 1, ...RESOLUTION }),
    );
    assert.equal(stale.code, "VERSION_CONFLICT");
    assert.deepEqual(stale.details, { currentVersion: 2 });

    const row = (await app.testDb.query<{ root_cause: string; fix_applied: string; version: number }>(
      "SELECT root_cause, fix_applied, version FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [owner.auth.organizationId, incident.id],
    ))[0];
    assert.deepEqual(row, {
      root_cause: "Deployment exhausted the connection pool",
      fix_applied: "Rolled back deployment and added pool alerts",
      version: 2,
    });
    const timeline = await app.incidents.timeline(owner.auth, incident.id, {});
    assert.deepEqual(timeline.map((event) => event.type), ["created", "resolution_changed", "resolution_changed"]);
    assert.deepEqual(timeline[1]?.payload, {
      operation: "created",
      version: 1,
      changes: {
        rootCause: { from: null, to: RESOLUTION.rootCause },
        fixApplied: { from: null, to: RESOLUTION.fixApplied },
      },
    });
    assert.deepEqual(timeline[2]?.payload, {
      operation: "updated",
      version: 2,
      changes: {
        rootCause: { from: RESOLUTION.rootCause, to: "Deployment exhausted the connection pool" },
        fixApplied: { from: RESOLUTION.fixApplied, to: "Rolled back deployment and added pool alerts" },
      },
    });
    assert.equal((await app.incidents.get(owner.auth, incident.id)).version, 1, "resolution changes do not bump incident version");
  });

  it("serializes concurrent edits using one expected resolution version", async () => {
    const owner = await app.register("resolution-concurrent@example.com");
    const incident = await app.incidents.create(owner.auth, INCIDENT);
    await app.incidents.createResolution(owner.auth, incident.id, RESOLUTION);

    const results = await concurrentPair(
      () => app.incidents.updateResolution(owner.auth, incident.id, { expectedVersion: 1, rootCause: "Cause A", fixApplied: "Fix A" }),
      () => app.incidents.updateResolution(owner.auth, incident.id, { expectedVersion: 1, rootCause: "Cause B", fixApplied: "Fix B" }),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof AppError);
    assert.equal(rejected.reason.code, "VERSION_CONFLICT");

    const current = (await app.testDb.query<{ version: number; root_cause: string; fix_applied: string }>(
      "SELECT version, root_cause, fix_applied FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [owner.auth.organizationId, incident.id],
    ))[0];
    assert.equal(current?.version, 2);
    assert.ok(["Cause A", "Cause B"].includes(current?.root_cause ?? ""));
    assert.ok(["Fix A", "Fix B"].includes(current?.fix_applied ?? ""));
    const timeline = await app.incidents.timeline(owner.auth, incident.id, {});
    assert.equal(timeline.filter((event) => event.type === "resolution_changed").length, 2);
  });

  it("does not update or audit unchanged resolution text and still rejects stale versions", async () => {
    const owner = await app.register("resolution-noop@example.com");
    const incident = await app.incidents.create(owner.auth, INCIDENT);
    const created = await app.incidents.createResolution(owner.auth, incident.id, RESOLUTION);
    const changed = await app.incidents.updateResolution(owner.auth, incident.id, {
      expectedVersion: created.version,
      rootCause: "Changed cause",
      fixApplied: "Changed fix",
    });
    assert.equal(changed.version, 2);

    const unchanged = await app.incidents.updateResolution(owner.auth, incident.id, {
      expectedVersion: changed.version,
      rootCause: changed.rootCause,
      fixApplied: changed.fixApplied,
    });
    assert.deepEqual(unchanged, changed);
    let timeline = await app.incidents.timeline(owner.auth, incident.id, {});
    assert.deepEqual(timeline.map((event) => event.type), ["created", "resolution_changed", "resolution_changed"]);

    const stale = await appError(
      app.incidents.updateResolution(owner.auth, incident.id, {
        expectedVersion: created.version,
        rootCause: changed.rootCause,
        fixApplied: changed.fixApplied,
      }),
    );
    assert.equal(stale.code, "VERSION_CONFLICT");
    assert.deepEqual(stale.details, { currentVersion: changed.version });
    timeline = await app.incidents.timeline(owner.auth, incident.id, {});
    assert.deepEqual(timeline.map((event) => event.type), ["created", "resolution_changed", "resolution_changed"]);

    const current = (await app.testDb.query<{ version: number; root_cause: string; fix_applied: string }>(
      "SELECT version, root_cause, fix_applied FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [owner.auth.organizationId, incident.id],
    ))[0];
    assert.deepEqual(current, {
      version: changed.version,
      root_cause: changed.rootCause,
      fix_applied: changed.fixApplied,
    });
  });

  it("requires responder permission, hides cross-organization incidents and rejects client-owned fields", async () => {
    const owner = await app.register("resolution-auth-owner@example.com");
    const viewer = await app.join(owner, "resolution-viewer@example.com", "viewer");
    const responder = await app.join(owner, "resolution-responder@example.com", "responder");
    const other = await app.register("resolution-other@example.com");
    const incident = await app.incidents.create(owner.auth, INCIDENT);

    assert.equal((await appError(app.incidents.createResolution(viewer.auth, incident.id, RESOLUTION))).code, "FORBIDDEN");
    const created = await app.incidents.createResolution(responder.auth, incident.id, RESOLUTION);
    assert.equal(created.resolvedBy, responder.me.user.id);
    assert.equal(
      (await appError(app.incidents.updateResolution(viewer.auth, incident.id, { expectedVersion: 1, ...RESOLUTION }))).code,
      "FORBIDDEN",
    );
    assert.equal((await appError(app.incidents.createResolution(other.auth, incident.id, RESOLUTION))).code, "NOT_FOUND");
    assert.equal((await appError(app.incidents.updateResolution(other.auth, incident.id, { expectedVersion: 1, ...RESOLUTION }))).code, "NOT_FOUND");
    assert.equal((await appError(app.incidents.createResolution(owner.auth, incident.id, { ...RESOLUTION, resolvedBy: other.me.user.id }))).code, "VALIDATION_FAILED");
    assert.equal((await appError(app.incidents.createResolution(owner.auth, incident.id, { ...RESOLUTION, organizationId: other.auth.organizationId }))).code, "VALIDATION_FAILED");
    assert.equal((await appError(app.incidents.updateResolution(owner.auth, incident.id, { expectedVersion: 1, ...RESOLUTION, version: 20 }))).code, "VALIDATION_FAILED");
    const count = await app.testDb.query<{ count: string }>(
      "SELECT count(*) AS count FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [owner.auth.organizationId, incident.id],
    );
    assert.equal(count[0]?.count, "1");
  });

  it("validates text at the API and database, and the trigger prevents forged stored versions", async () => {
    const owner = await app.register("resolution-constraints@example.com");
    const incident = await app.incidents.create(owner.auth, INCIDENT);
    for (const invalid of [
      {},
      { rootCause: " ", fixApplied: "fix" },
      { rootCause: "x".repeat(2001), fixApplied: "fix" },
      { rootCause: "cause", fixApplied: "fix".repeat(1001) },
    ]) {
      assert.equal((await appError(app.incidents.createResolution(owner.auth, incident.id, invalid))).code, "VALIDATION_FAILED");
    }
    for (const invalid of [
      { expectedVersion: 1, rootCause: "cause", fixApplied: " " },
      { expectedVersion: 1, rootCause: "x".repeat(2001), fixApplied: "fix" },
      { expectedVersion: 1, rootCause: "cause", fixApplied: "fix".repeat(1001) },
    ]) {
      assert.equal((await appError(app.incidents.updateResolution(owner.auth, incident.id, invalid))).code, "VALIDATION_FAILED");
    }
    await app.incidents.createResolution(owner.auth, incident.id, RESOLUTION);
    await assert.rejects(
      app.testDb.query(
        "UPDATE incident_resolutions SET root_cause = $3 WHERE organization_id = $1 AND incident_id = $2",
        [owner.auth.organizationId, incident.id, "x".repeat(2001)],
      ),
    );
    await assert.rejects(
      app.testDb.query(
        "UPDATE incident_resolutions SET fix_applied = $3 WHERE organization_id = $1 AND incident_id = $2",
        [owner.auth.organizationId, incident.id, "x".repeat(2001)],
      ),
    );
    await assert.rejects(
      app.testDb.query(
        "UPDATE incident_resolutions SET fix_applied = '   ' WHERE organization_id = $1 AND incident_id = $2",
        [owner.auth.organizationId, incident.id],
      ),
    );
    await app.testDb.query(
      "UPDATE incident_resolutions SET version = 900 WHERE organization_id = $1 AND incident_id = $2",
      [owner.auth.organizationId, incident.id],
    );
    const current = (await app.testDb.query<{ version: number }>(
      "SELECT version FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [owner.auth.organizationId, incident.id],
    ))[0];
    assert.equal(current?.version, 2, "the database trigger computes version from the old row");
  });

  it("rolls back a resolution if its immutable audit event cannot be inserted", async () => {
    const owner = await app.register("resolution-rollback@example.com");
    const incident = await app.incidents.create(owner.auth, INCIDENT);
    await app.testDb.query(`
      CREATE FUNCTION reject_resolution_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type = 'resolution_changed' THEN
          RAISE EXCEPTION 'test audit rejection' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $$;
    `);
    try {
      await app.testDb.query(
        `CREATE TRIGGER reject_resolution_audit_before_insert
           BEFORE INSERT ON incident_events FOR EACH ROW EXECUTE FUNCTION reject_resolution_audit()`,
      );
      await assert.rejects(
        app.incidents.createResolution(owner.auth, incident.id, {
          rootCause: "quarantinezimble",
          fixApplied: "restartzimble",
        }),
      );
      const counts = await app.testDb.query<{ resolutions: string; events: string; documentHasRolledBackTerms: boolean }>(
        `SELECT
           (SELECT count(*) FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2) AS resolutions,
           (SELECT count(*) FROM incident_events WHERE organization_id = $1 AND incident_id = $2 AND type = 'resolution_changed') AS events,
           (SELECT position('quarantinezimble' in search_vector::text) > 0
              FROM incident_search_documents WHERE organization_id = $1 AND incident_id = $2) AS "documentHasRolledBackTerms"`,
        [owner.auth.organizationId, incident.id],
      );
      assert.deepEqual(counts[0], { resolutions: "0", events: "0", documentHasRolledBackTerms: false });
    } finally {
      await app.testDb.query("DROP TRIGGER reject_resolution_audit_before_insert ON incident_events");
      await app.testDb.query("DROP FUNCTION reject_resolution_audit()");
    }
  });

  it("rolls back resolution edits and the version increment if the audit insert fails", async () => {
    const owner = await app.register("resolution-update-rollback@example.com");
    const incident = await app.incidents.create(owner.auth, INCIDENT);
    const created = await app.incidents.createResolution(owner.auth, incident.id, RESOLUTION);
    const eventsBefore = await app.testDb.query<{ count: string }>(
      "SELECT count(*) AS count FROM incident_events WHERE organization_id = $1 AND incident_id = $2 AND type = 'resolution_changed'",
      [owner.auth.organizationId, incident.id],
    );
    await app.testDb.query(`
      CREATE FUNCTION reject_resolution_update_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type = 'resolution_changed' THEN
          RAISE EXCEPTION 'test audit rejection' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $$;
    `);
    try {
      await app.testDb.query(
        `CREATE TRIGGER reject_resolution_update_audit_before_insert
           BEFORE INSERT ON incident_events FOR EACH ROW EXECUTE FUNCTION reject_resolution_update_audit()`,
      );
      await assert.rejects(
        app.incidents.updateResolution(owner.auth, incident.id, {
          expectedVersion: created.version,
          rootCause: "Changed cause",
          fixApplied: "Changed fix",
        }),
      );
      const row = (await app.testDb.query<{ version: number; root_cause: string; fix_applied: string }>(
        "SELECT version, root_cause, fix_applied FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
        [owner.auth.organizationId, incident.id],
      ))[0];
      assert.deepEqual(row, {
        version: created.version,
        root_cause: RESOLUTION.rootCause,
        fix_applied: RESOLUTION.fixApplied,
      });
      const eventsAfter = await app.testDb.query<{ count: string }>(
        "SELECT count(*) AS count FROM incident_events WHERE organization_id = $1 AND incident_id = $2 AND type = 'resolution_changed'",
        [owner.auth.organizationId, incident.id],
      );
      assert.deepEqual(eventsAfter, eventsBefore);
    } finally {
      await app.testDb.query("DROP TRIGGER reject_resolution_update_audit_before_insert ON incident_events");
      await app.testDb.query("DROP FUNCTION reject_resolution_update_audit()");
    }
  });

  it("allows an independent status transition alongside resolution creation and nulls resolver on membership removal", async () => {
    const owner = await app.register("resolution-lifecycle-owner@example.com");
    const responder = await app.join(owner, "resolution-lifecycle-responder@example.com", "responder");
    const incident = await app.incidents.create(owner.auth, INCIDENT);
    const results = await concurrentPair(
      () => app.incidents.transition(owner.auth, incident.id, { to: "acknowledged", expectedVersion: 1 }),
      () => app.incidents.createResolution(responder.auth, incident.id, RESOLUTION),
    );
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
    const updatedIncident = await app.incidents.get(owner.auth, incident.id);
    assert.equal(updatedIncident.status, "acknowledged");
    assert.equal(updatedIncident.version, 2);
    const timeline = await app.incidents.timeline(owner.auth, incident.id, {});
    assert.equal(timeline[0]?.type, "created");
    assert.deepEqual(
      timeline.slice(1).map((event) => event.type).sort(),
      ["resolution_changed", "status_changed"],
    );
    const resolution = await app.incidents.getResolution(owner.auth, incident.id);
    assert.deepEqual(
      { rootCause: resolution.rootCause, fixApplied: resolution.fixApplied, version: resolution.version },
      { ...RESOLUTION, version: 1 },
    );

    await app.organizations.removeMember(owner.auth, responder.me.user.id);
    const resolver = (await app.testDb.query<{ resolved_by: string | null }>(
      "SELECT resolved_by FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [owner.auth.organizationId, incident.id],
    ))[0];
    assert.equal(resolver?.resolved_by, null);
  });

  it("does not require resolution text to transition an incident to resolved", async () => {
    const owner = await app.register("resolution-optional@example.com");
    const incident = await app.incidents.create(owner.auth, INCIDENT);
    const resolved = await app.incidents.transition(owner.auth, incident.id, { to: "resolved", expectedVersion: 1 });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.version, 2);
    const resolutionCount = await app.testDb.query<{ count: string }>(
      "SELECT count(*) AS count FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [owner.auth.organizationId, incident.id],
    );
    assert.equal(resolutionCount[0]?.count, "0");
  });
});
