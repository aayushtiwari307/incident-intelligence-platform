import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../test-support/session-factory";
import { runMigrations } from "./runner";

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b1";
const OWNER_A = "00000000-0000-0000-0000-0000000001a1";
const RESOLVER_A = "00000000-0000-0000-0000-0000000001a2";
const OWNER_B = "00000000-0000-0000-0000-0000000001b1";
const INCIDENT_A = "00000000-0000-0000-0000-0000000002a1";
const INCIDENT_B = "00000000-0000-0000-0000-0000000002b1";
const INCIDENT_NEW = "00000000-0000-0000-0000-0000000002a2";
const INCIDENT_CONCURRENT = "00000000-0000-0000-0000-0000000002a3";

async function sqlState(db: TestDatabase, sql: string, params: readonly unknown[] = []): Promise<string> {
  const session = await db.connect();
  try {
    await session.query("BEGIN");
    try {
      await session.query(sql, params);
      await session.query("ROLLBACK");
      return "ok";
    } catch (error) {
      await session.query("ROLLBACK");
      return (error as { code?: string }).code ?? "unknown";
    }
  } finally {
    await session.close();
  }
}

async function waitUntilAdvisoryBlocked(db: TestDatabase, pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [activity] = await db.query<{ wait_event_type: string | null; wait_event: string | null }>(
      "SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (activity?.wait_event_type === "Lock" && activity.wait_event === "advisory") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("resolution refresh did not block on the incident-scoped advisory lock");
}

describe("incident resolutions and search documents (real PostgreSQL)", () => {
  let db: TestDatabase;
  let migrationsDirectory: string;
  let priorMigrationsDirectory: string;

  beforeAll(async () => {
    migrationsDirectory = path.resolve(__dirname, "../../../migrations");
    priorMigrationsDirectory = mkdtempSync(path.join(os.tmpdir(), "incident-search-prior-migrations-"));
    const priorFiles = readdirSync(migrationsDirectory)
      .filter((filename) => /^000[1-7]_.+\.sql$/.test(filename))
      .sort();
    assert.equal(priorFiles.at(-1)?.slice(0, 4), "0007", "the setup must stop after migration 0007");
    for (const filename of priorFiles) {
      copyFileSync(path.join(migrationsDirectory, filename), path.join(priorMigrationsDirectory, filename));
    }

    db = await createTestDatabase();
    await runMigrations(db.connect, { mode: "apply", directory: priorMigrationsDirectory });

    const session = await db.connect();
    try {
      await session.query("BEGIN");
      for (const [id, email] of [
        [OWNER_A, "owner-a@example.com"],
        [RESOLVER_A, "resolver-a@example.com"],
        [OWNER_B, "owner-b@example.com"],
      ]) {
        await session.query(
          "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, 'Test user')",
          [id, email, "x".repeat(30)],
        );
      }
      await session.query("INSERT INTO organizations (id, slug, name) VALUES ($1, 'search-a', 'Search A'), ($2, 'search-b', 'Search B')", [
        ORG_A,
        ORG_B,
      ]);
      await session.query(
        "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'responder'), ($4, $5, 'owner')",
        [ORG_A, OWNER_A, RESOLVER_A, ORG_B, OWNER_B],
      );
      await session.query(
        `INSERT INTO incidents (id, organization_id, number, title, description, severity, created_by)
         VALUES ($1, $2, 1, 'zebra titleword', 'descriptionword', 'sev2', $3),
                ($4, $5, 1, 'otter secondtitle', 'seconddescription', 'sev3', $6)`,
        [INCIDENT_A, ORG_A, OWNER_A, INCIDENT_B, ORG_B, OWNER_B],
      );
      await session.query("COMMIT");
    } catch (error) {
      await session.query("ROLLBACK");
      throw error;
    } finally {
      await session.close();
    }

    const result = await runMigrations(db.connect, { mode: "apply", directory: migrationsDirectory });
    assert.deepEqual(result.applied, [
      "0008_incident_resolutions_search.sql",
      "0009_resolution_audit_events.sql",
      "0010_resolution_nonblank_text.sql",
      "0011_resolution_raw_text_length.sql",
      "0012_grounded_ai_suggestions.sql",
    ]);
  });

  afterAll(async () => {
    if (db) await db.drop();
    if (priorMigrationsDirectory) rmSync(priorMigrationsDirectory, { recursive: true, force: true });
  });

  it("backfills incidents that predate 0008 without inventing resolutions", async () => {
    const documents = await db.query<{ organization_id: string; incident_id: string; vector: string }>(
      "SELECT organization_id, incident_id, search_vector::text AS vector FROM incident_search_documents ORDER BY incident_id",
    );
    assert.deepEqual(
      documents.map(({ incident_id }) => incident_id),
      [INCIDENT_A, INCIDENT_B].sort(),
    );
    assert.match(documents.find((doc) => doc.incident_id === INCIDENT_A)?.vector ?? "", /'titleword':\d+A/);
    assert.match(documents.find((doc) => doc.incident_id === INCIDENT_A)?.vector ?? "", /'descriptionword':\d+B/);
    assert.equal((await db.query("SELECT incident_id FROM incident_resolutions")).length, 0);
  });

  it("rejects refreshes using a transaction snapshot that cannot see lock-wait commits", async () => {
    const session = await db.connect();
    let result = "ok";
    try {
      await session.query("BEGIN");
      await session.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await session.query("UPDATE incidents SET title = 'unsupported isolation' WHERE id = $1", [INCIDENT_A]);
    } catch (error) {
      result = (error as { code?: string }).code ?? "unknown";
    } finally {
      await session.query("ROLLBACK");
      await session.close();
    }
    assert.equal(result, "0A000");
    const [incident] = await db.query<{ title: string; version: number }>("SELECT title, version FROM incidents WHERE id = $1", [
      INCIDENT_A,
    ]);
    assert.equal(incident?.title, "zebra titleword");
    assert.equal(incident?.version, 1);
  });

  it("rejects cross-tenant incident and resolver references", async () => {
    const crossTenantIncident = await sqlState(
      db,
      `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied, resolved_by)
       VALUES ($1, $2, 'cause', 'fix', $3)`,
      [ORG_A, INCIDENT_B, RESOLVER_A],
    );
    const crossTenantResolver = await sqlState(
      db,
      `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied, resolved_by)
       VALUES ($1, $2, 'cause', 'fix', $3)`,
      [ORG_A, INCIDENT_A, OWNER_B],
    );
    const crossTenantDocument = await sqlState(
      db,
      `INSERT INTO incident_search_documents (organization_id, incident_id, search_vector)
       VALUES ($1, $2, to_tsvector('english', 'term'))`,
      [ORG_A, INCIDENT_B],
    );
    assert.equal(crossTenantIncident, "23503");
    assert.equal(crossTenantResolver, "23503");
    assert.equal(crossTenantDocument, "23503");
    assert.equal(
      await sqlState(
        db,
        `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied)
         VALUES ($1, $2, $3, 'fix')`,
        [ORG_A, INCIDENT_A, "c".repeat(2001)],
      ),
      "23514",
    );
    assert.equal(
      await sqlState(
        db,
        `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied)
         VALUES ($1, $2, 'cause', $3)`,
        [ORG_A, INCIDENT_A, " ".repeat(10)],
      ),
      "23514",
      "fix_applied must not be blank",
    );
    assert.equal(
      await sqlState(
        db,
        `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied)
         VALUES ($1, $2, 'cause', $3)`,
        [ORG_A, INCIDENT_A, "f".repeat(2001)],
      ),
      "23514",
      "fix_applied must be bounded",
    );
    assert.equal(
      await sqlState(
        db,
        `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied)
         VALUES ($1, $2, $3, 'fix')`,
        [ORG_A, INCIDENT_A, " ".repeat(10)],
      ),
      "23514",
      "root_cause must not be blank",
    );
  });

  it("enforces raw 2000-character resolution limits for both stored text fields", async () => {
    for (const field of ["root_cause", "fix_applied"] as const) {
      const params = [
        ORG_A,
        INCIDENT_A,
        field === "root_cause" ? `cause${" ".repeat(1996)}` : "Valid cause",
        field === "fix_applied" ? `fix${" ".repeat(1998)}` : "Valid fix",
      ];
      assert.equal(
        await sqlState(
          db,
          `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied)
           VALUES ($1, $2, $3, $4)`,
          params,
        ),
        "23514",
        `${field} accepted nonblank text padded beyond 2000 characters`,
      );

      const exactLimit = [
        ORG_A,
        INCIDENT_A,
        field === "root_cause" ? "c".repeat(2000) : "Valid cause",
        field === "fix_applied" ? "f".repeat(2000) : "Valid fix",
      ];
      assert.equal(
        await sqlState(
          db,
          `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied)
           VALUES ($1, $2, $3, $4)`,
          exactLimit,
        ),
        "ok",
        `${field} rejected valid text at exactly 2000 characters`,
      );
    }
  });

  it("enforces nonblank root causes and fixes using PostgreSQL whitespace matching", async () => {
    const whitespaceOnly = [" ", "\t", "\n", "\r", " \t\n\r "];
    for (const field of ["root_cause", "fix_applied"] as const) {
      for (const value of whitespaceOnly) {
        const result = await sqlState(
          db,
          `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied)
           VALUES ($1, $2, $3, $4)`,
          [
            ORG_A,
            INCIDENT_A,
            field === "root_cause" ? value : "Legitimate cause",
            field === "fix_applied" ? value : "Legitimate fix",
          ],
        );
        assert.equal(result, "23514", `${field} accepted whitespace-only value ${JSON.stringify(value)}`);
      }

      const valid = await sqlState(
        db,
        `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied)
         VALUES ($1, $2, $3, $4)`,
        [
          ORG_A,
          INCIDENT_A,
          field === "root_cause" ? "Cause with surrounding whitespace" : "Legitimate cause",
          field === "fix_applied" ? "Fix with surrounding whitespace" : "Legitimate fix",
        ],
      );
      assert.equal(valid, "ok", `${field} rejected legitimate nonblank text`);
    }
  });

  it("refreshes derived vectors, versions resolutions, and preserves data on reapplication and cascades", async () => {
    const [beforeIncident] = await db.query<{ version: number }>("SELECT version FROM incidents WHERE id = $1", [INCIDENT_A]);
    const [beforeEvents] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_events WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_A],
    );
    await db.query(
      `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied, resolved_by)
       VALUES ($1, $2, 'causeword', 'fixword', $3)`,
      [ORG_A, INCIDENT_A, RESOLVER_A],
    );
    const [createdResolution] = await db.query<{ version: number }>(
      "SELECT version FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_A],
    );
    assert.equal(createdResolution?.version, 1);
    let [document] = await db.query<{ vector: string }>(
      "SELECT search_vector::text AS vector FROM incident_search_documents WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_A],
    );
    assert.match(document?.vector ?? "", /'causeword':\d+C/);
    assert.match(document?.vector ?? "", /'fixword':\d+C/);

    const [updatedResolution] = await db.query<{ version: number; updated_at: Date; created_at: Date }>(
      `UPDATE incident_resolutions SET root_cause = 'newcauseword', fix_applied = 'newfixword', version = 99
       WHERE organization_id = $1 AND incident_id = $2
       RETURNING version, updated_at, created_at`,
      [ORG_A, INCIDENT_A],
    );
    assert.equal(updatedResolution?.version, 2, "the database owns resolution version increments");
    assert.ok(updatedResolution?.updated_at && updatedResolution.updated_at >= updatedResolution.created_at);
    [document] = await db.query<{ vector: string }>(
      "SELECT search_vector::text AS vector FROM incident_search_documents WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_A],
    );
    assert.match(document?.vector ?? "", /'newcauseword':\d+C/);
    assert.match(document?.vector ?? "", /'newfixword':\d+C/);
    assert.doesNotMatch(document?.vector ?? "", /'causeword':\d+C/);

    await db.query("DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2", [ORG_A, RESOLVER_A]);
    const [afterMemberRemoval] = await db.query<{ resolved_by: string | null; version: number }>(
      "SELECT resolved_by, version FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_A],
    );
    assert.equal(afterMemberRemoval?.resolved_by, null);
    assert.equal(afterMemberRemoval?.version, 3);
    assert.equal(
      await sqlState(
        db,
        `UPDATE incident_resolutions SET incident_id = $3
         WHERE organization_id = $1 AND incident_id = $2`,
        [ORG_A, INCIDENT_A, INCIDENT_B],
      ),
      "23514",
      "resolution incident identity must be immutable",
    );

    const migrationSql = readFileSync(path.join(migrationsDirectory, "0008_incident_resolutions_search.sql"), "utf8");
    await db.query(migrationSql);
    const [afterReapply] = await db.query<{ root_cause: string; fix_applied: string; resolved_by: string | null; version: number }>(
      `SELECT root_cause, fix_applied, resolved_by, version FROM incident_resolutions
       WHERE organization_id = $1 AND incident_id = $2`,
      [ORG_A, INCIDENT_A],
    );
    assert.deepEqual(afterReapply, {
      root_cause: "newcauseword",
      fix_applied: "newfixword",
      resolved_by: null,
      version: 3,
    });
    const [afterReapplyDocumentCount] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_search_documents",
    );
    assert.equal(afterReapplyDocumentCount?.count, "2");
    const [afterReapplyResolutionCount] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_resolutions",
    );
    assert.equal(afterReapplyResolutionCount?.count, "1");

    await db.query(
      `INSERT INTO incidents (id, organization_id, number, title, description, severity, created_by)
       VALUES ($1, $2, 2, 'fresh titlefresh', 'fresh descriptionfresh', 'sev2', $3)`,
      [INCIDENT_NEW, ORG_A, OWNER_A],
    );
    let [newDocument] = await db.query<{ vector: string }>(
      "SELECT search_vector::text AS vector FROM incident_search_documents WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_NEW],
    );
    assert.match(newDocument?.vector ?? "", /'titlefresh':\d+A/);
    assert.match(newDocument?.vector ?? "", /'descriptionfresh':\d+B/);
    await db.query("UPDATE incidents SET title = 'edited titleedited', description = 'edited descriptionedited' WHERE id = $1", [
      INCIDENT_NEW,
    ]);
    const [editedIncident] = await db.query<{ version: number }>("SELECT version FROM incidents WHERE id = $1", [INCIDENT_NEW]);
    const [newIncidentEvents] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_events WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_NEW],
    );
    [newDocument] = await db.query<{ vector: string }>(
      "SELECT search_vector::text AS vector FROM incident_search_documents WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_NEW],
    );
    assert.equal(editedIncident?.version, 2);
    assert.match(newDocument?.vector ?? "", /'titleedit':\d+A/);
    assert.match(newDocument?.vector ?? "", /'descriptionedit':\d+B/);
    assert.doesNotMatch(newDocument?.vector ?? "", /'titlefresh':\d+A/);
    assert.equal(newIncidentEvents?.count, "0");

    await db.query("DELETE FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2", [ORG_A, INCIDENT_A]);
    [document] = await db.query<{ vector: string }>(
      "SELECT search_vector::text AS vector FROM incident_search_documents WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_A],
    );
    assert.doesNotMatch(document?.vector ?? "", /'newcauseword':\d+C|'newfixword':\d+C/);
    assert.match(document?.vector ?? "", /'titleword':\d+A/);

    await db.query(
      `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied, resolved_by)
       VALUES ($1, $2, 'cascadecause', 'cascadefix', $3)`,
      [ORG_B, INCIDENT_B, OWNER_B],
    );
    await db.query("DELETE FROM incidents WHERE organization_id = $1 AND id = $2", [ORG_B, INCIDENT_B]);
    assert.equal(
      (
        await db.query(
          `SELECT incident_id FROM incident_search_documents WHERE organization_id = $1 AND incident_id = $2
           UNION ALL
           SELECT incident_id FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2`,
          [ORG_B, INCIDENT_B],
        )
      ).length,
      0,
      "deleting an incident cascades to its resolution and search document",
    );

    const [afterResolutionChanges] = await db.query<{ version: number }>("SELECT version FROM incidents WHERE id = $1", [INCIDENT_A]);
    const [afterResolutionEvents] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_events WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_A],
    );
    assert.equal(afterResolutionChanges?.version, beforeIncident?.version);
    assert.equal(afterResolutionEvents?.count, beforeEvents?.count);
    const [finalDocumentCount] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_search_documents",
    );
    assert.equal(finalDocumentCount?.count, "2");
  });

  it("serializes concurrent text and resolution refreshes without retaining stale terms", async () => {
    await db.query(
      `INSERT INTO incidents (id, organization_id, number, title, description, severity, created_by)
       VALUES ($1, $2, 3, 'oldtitlemarker', 'olddescriptionmarker', 'sev2', $3)`,
      [INCIDENT_CONCURRENT, ORG_A, OWNER_A],
    );
    await db.query(
      `INSERT INTO incident_resolutions (organization_id, incident_id, root_cause, fix_applied, resolved_by)
       VALUES ($1, $2, 'oldcausemarker', 'oldfixmarker', $3)`,
      [ORG_A, INCIDENT_CONCURRENT, OWNER_A],
    );
    const [before] = await db.query<{ version: number }>("SELECT version FROM incidents WHERE id = $1", [INCIDENT_CONCURRENT]);
    const [eventsBefore] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_events WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_CONCURRENT],
    );

    const textWriter = await db.connect();
    const resolutionWriter = await db.connect();
    let textTransactionOpen = false;
    let resolutionTransactionOpen = false;
    try {
      await textWriter.query("BEGIN");
      textTransactionOpen = true;
      await textWriter.query(
        "UPDATE incidents SET title = 'newtitlemarker', description = 'newdescriptionmarker' WHERE id = $1",
        [INCIDENT_CONCURRENT],
      );

      const resolutionPidResult = await resolutionWriter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const resolutionPid = resolutionPidResult.rows[0]?.pid;
      assert.ok(resolutionPid, "resolution writer backend PID is available");
      await resolutionWriter.query("BEGIN");
      resolutionTransactionOpen = true;
      const resolutionUpdate = resolutionWriter.query(
        `UPDATE incident_resolutions SET root_cause = 'newcausemarker', fix_applied = 'newfixmarker'
         WHERE organization_id = $1 AND incident_id = $2`,
        [ORG_A, INCIDENT_CONCURRENT],
      );
      await waitUntilAdvisoryBlocked(db, resolutionPid);

      await textWriter.query("COMMIT");
      textTransactionOpen = false;
      await resolutionUpdate;
      await resolutionWriter.query("COMMIT");
      resolutionTransactionOpen = false;
    } finally {
      if (resolutionTransactionOpen) await resolutionWriter.query("ROLLBACK");
      if (textTransactionOpen) await textWriter.query("ROLLBACK");
      await textWriter.close();
      await resolutionWriter.close();
    }

    const [finalDocument] = await db.query<{ vector: string }>(
      "SELECT search_vector::text AS vector FROM incident_search_documents WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_CONCURRENT],
    );
    for (const [term, weight] of [
      ["newtitlemark", "A"],
      ["newdescriptionmark", "B"],
      ["newcausemark", "C"],
      ["newfixmark", "C"],
    ]) {
      assert.match(finalDocument?.vector ?? "", new RegExp(`'${term}':\\d+${weight}`));
    }
    for (const oldTerm of ["oldtitlemark", "olddescriptionmark", "oldcausemark", "oldfixmark"]) {
      assert.doesNotMatch(finalDocument?.vector ?? "", new RegExp(`'${oldTerm}':\\d+[ABC]`));
    }
    const [finalIncident] = await db.query<{ version: number }>("SELECT version FROM incidents WHERE id = $1", [INCIDENT_CONCURRENT]);
    const [finalResolution] = await db.query<{ version: number }>(
      "SELECT version FROM incident_resolutions WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_CONCURRENT],
    );
    const [eventsAfter] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_events WHERE organization_id = $1 AND incident_id = $2",
      [ORG_A, INCIDENT_CONCURRENT],
    );
    assert.equal(finalIncident?.version, (before?.version ?? 0) + 1);
    assert.equal(finalResolution?.version, 2);
    assert.equal(eventsAfter?.count, eventsBefore?.count);

    await db.query("DELETE FROM incidents WHERE organization_id = $1 AND id = $2", [ORG_A, INCIDENT_CONCURRENT]);
    const [remainingDocuments] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_search_documents",
    );
    const [remainingResolutions] = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM incident_resolutions",
    );
    assert.equal(remainingDocuments?.count, "2");
    assert.equal(remainingResolutions?.count, "0");
  });
});
