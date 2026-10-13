import assert from "node:assert/strict";
import type { AnalysisResult } from "@platform/shared";
import type { SqlClient } from "../common/sql";
import { AnalysisJobHandler, ANALYZE_INCIDENT_JOB } from "../analysis/analysis.handler";
import type { AnalysisProvider } from "../analysis/provider";
import { createTestApp, type TestApp } from "../test-support/app-harness";
import type { JobRow } from "./job-queue";
import { JobError, JobWorker, exponentialBackoff, type JobHandler } from "./job-worker";

/** A handler whose behaviour each test scripts; records every execution. */
function scripted(type: string, behave: (job: JobRow, n: number) => Promise<void> | void = () => undefined) {
  const runs: Array<{ jobId: string; attempt: number }> = [];
  const failures: Array<{ code: string; final: boolean }> = [];
  const commits: string[] = [];
  const handler: JobHandler<null> = {
    type,
    async execute(job) {
      runs.push({ jobId: job.id, attempt: job.attempts });
      await behave(job, runs.length);
      return null;
    },
    async commit(_tx: SqlClient, job: JobRow) {
      commits.push(job.id);
    },
    async onFailure(_tx: SqlClient, _job: JobRow, error: JobError, final: boolean) {
      failures.push({ code: error.code, final });
    },
  };
  return { handler, runs, failures, commits };
}

describe("durable job queue (real PostgreSQL)", () => {
  let app: TestApp;
  let orgId: string;
  beforeEach(async () => {
    app = await createTestApp();
    orgId = (await app.register("q@example.com")).me.activeOrganizationId as string;
  });
  afterEach(async () => {
    await app.close();
  });

  const worker = (handlers: JobHandler[], workerId: string, extra: { leaseSeconds?: number } = {}) =>
    new JobWorker(app.database, app.queue, handlers, { workerId, leaseSeconds: extra.leaseSeconds ?? 60, pollIntervalMs: 10, backoffSeconds: () => 0 });
  const enqueue = (type = "noop", maxAttempts = 3) => app.database.tx((tx) => app.queue.enqueue(tx, { organizationId: orgId, type, maxAttempts }));
  const job = async (id: string) => (await app.testDb.query<{ status: string; attempts: number; last_error: string | null; locked_by: string | null }>("SELECT status, attempts, last_error, locked_by FROM jobs WHERE id = $1", [id]))[0];

  it("outbox: a job enqueued in a transaction that rolls back never exists", async () => {
    await assert.rejects(
      app.database.tx(async (tx) => {
        await app.queue.enqueue(tx, { organizationId: orgId, type: "noop" });
        throw new Error("business change failed");
      }),
    );
    assert.equal((await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM jobs"))[0]?.n, "0");
  });

  it("two workers draining 40 jobs run each job exactly once", async () => {
    const a = scripted("noop", () => new Promise((r) => setTimeout(r, 5)));
    const b = scripted("noop", () => new Promise((r) => setTimeout(r, 5)));
    for (let i = 0; i < 40; i++) await enqueue();
    const drain = async (w: JobWorker) => {
      while (await w.runOnce());
    };
    await Promise.all([drain(worker([a.handler], "w-a")), drain(worker([b.handler], "w-b"))]);
    const ids = [...a.runs, ...b.runs].map((r) => r.jobId);
    assert.equal(ids.length, 40);
    assert.equal(new Set(ids).size, 40, "no job ran twice");
    assert.ok(a.runs.length > 0 && b.runs.length > 0, "both workers took part");
    assert.equal((await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM jobs WHERE status = 'succeeded'"))[0]?.n, "40");
  });

  it("SKIP LOCKED: a job locked by another transaction is skipped, not waited for", async () => {
    const first = await enqueue();
    const second = await enqueue();
    const holder = await app.database.tx(async (tx) => {
      await tx.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [first]);
      // claim from a different connection while the first job's row is locked
      const claimed = await app.queue.claim("w-skip", 60);
      return claimed?.id;
    });
    assert.equal(holder, second);
  });

  it("retries a failing job with backoff bookkeeping and ends dead after max attempts, recording a redacted error", async () => {
    const s = scripted("flaky", () => {
      throw new JobError("provider_error", "boom postgres://u:hunter2secret@db/x Bearer abc.def", true);
    });
    const id = await enqueue("flaky", 3);
    const w = worker([s.handler], "w1");
    while (await w.runOnce());
    const row = await job(id);
    assert.equal(row?.status, "dead");
    assert.equal(Number(row?.attempts), 3);
    assert.ok(!row?.last_error?.includes("hunter2secret") && !row?.last_error?.includes("abc.def"), `error leaked: ${row?.last_error}`);
    assert.deepEqual(s.failures.map((f) => f.final), [false, false, true]);
  });

  it("a non-retryable failure is dead after one attempt", async () => {
    const s = scripted("perm", () => {
      throw new JobError("invalid_output", "bad", false);
    });
    const id = await enqueue("perm", 5);
    const w = worker([s.handler], "w1");
    while (await w.runOnce());
    assert.equal(Number((await job(id))?.attempts), 1);
    assert.equal((await job(id))?.status, "dead");
  });

  it("a retry is not run before its delay elapses", async () => {
    const s = scripted("delayed", () => {
      throw new JobError("timeout", "slow", true);
    });
    const id = await enqueue("delayed", 3);
    const slow = new JobWorker(app.database, app.queue, [s.handler], { workerId: "w1", leaseSeconds: 60, pollIntervalMs: 10, backoffSeconds: () => 3600 });
    assert.equal(await slow.runOnce(), true);
    assert.equal(await slow.runOnce(), false, "the retry is scheduled an hour out");
    assert.equal((await job(id))?.status, "pending");
  });

  it("an expired lease is taken over, and the previous owner's late result is fenced off", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = scripted("lease", async (_j, n) => {
      if (n === 1) await gate; // the first execution hangs past its lease
    });
    const id = await enqueue("lease", 3);
    const wA = worker([slow.handler], "w-a");
    const wB = worker([slow.handler], "w-b");

    const firstRun = wA.runOnce(); // claims, then blocks in execute
    await new Promise((r) => setTimeout(r, 100));
    await app.testDb.query("UPDATE jobs SET locked_until = now() - interval '1 minute' WHERE id = $1", [id]);
    assert.equal(await wB.runOnce(), true, "worker B reclaims the expired lease");
    assert.equal((await job(id))?.status, "succeeded");

    release();
    await firstRun; // A finishes late: must not overwrite B's outcome
    const row = await job(id);
    assert.equal(row?.status, "succeeded");
    assert.equal(Number(row?.attempts), 2);
    assert.equal(slow.runs.length, 2, "at-least-once delivery: the job body ran twice");
    assert.equal(slow.commits.length, 1, "but only the current lease holder committed a result");
  });

  it("a job whose lease expired after its last attempt is marked dead and its owner is told", async () => {
    const s = scripted("exhausted");
    const id = await enqueue("exhausted", 1);
    const claimed = await app.queue.claim("crashed-worker", 60); // attempt 1 of 1, then the worker "crashes"
    assert.equal(claimed?.id, id);
    await app.testDb.query("UPDATE jobs SET locked_until = now() - interval '1 minute' WHERE id = $1", [id]);
    await worker([s.handler], "w-reaper").runOnce();
    assert.equal((await job(id))?.status, "dead");
    assert.deepEqual(s.failures, [{ code: "timeout", final: true }]);
    assert.equal(s.runs.length, 0, "an exhausted job is never run again");
  });

  it("a poisoned exhausted-job handler does not starve healthy work and keeps analysis state recoverable", async () => {
    const owner = await app.register("poison@example.com");
    const incident = await app.incidents.create(owner.auth, {
      title: "Queue reaper failure",
      description: "Exercise a failed exhausted-job notification",
      severity: "sev3",
    });
    const ownerOrgId = owner.me.activeOrganizationId as string;
    const analysisRows = await app.testDb.query<{ id: string }>(
      `INSERT INTO incident_analyses (organization_id, incident_id, status, incident_version, requested_by)
       VALUES ($1, $2, 'running', $3, $4) RETURNING id`,
      [ownerOrgId, incident.id, incident.version, owner.auth.userId],
    );
    const analysisId = analysisRows[0]?.id;
    assert.ok(analysisId);
    const poisonId = await app.database.tx(async (tx) => {
      const id = await app.queue.enqueue(tx, {
        organizationId: ownerOrgId,
        type: ANALYZE_INCIDENT_JOB,
        payload: { analysisId },
        maxAttempts: 1,
      });
      await tx.query("UPDATE incident_analyses SET job_id = $3 WHERE organization_id = $1 AND id = $2", [ownerOrgId, analysisId, id]);
      return id;
    });
    const claimed = await app.queue.claim("crashed-worker", 60);
    assert.equal(claimed?.id, poisonId);
    await app.testDb.query("UPDATE jobs SET locked_until = now() - interval '1 minute' WHERE id = $1", [poisonId]);

    const provider: AnalysisProvider = { model: "not-used", async analyze() { throw new Error("expired work must not execute"); } };
    const delegate = new AnalysisJobHandler(app.database, provider);
    let notificationAttempts = 0;
    const failingHandler: JobHandler<AnalysisResult> = {
      type: delegate.type,
      execute: delegate.execute.bind(delegate),
      commit: delegate.commit.bind(delegate),
      onStart: delegate.onStart?.bind(delegate),
      async onFailure(tx, dead, error, final) {
        notificationAttempts++;
        if (notificationAttempts <= 2) throw new Error("simulated poisoned finalization");
        await delegate.onFailure(tx, dead, error, final);
      },
    };
    const healthy = scripted("healthy");
    const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const reaper = new JobWorker(app.database, app.queue, [failingHandler, healthy.handler], {
      workerId: "w-reaper",
      leaseSeconds: 60,
      pollIntervalMs: 10,
      backoffSeconds: () => 0,
      log: (message, fields) => logs.push({ message, fields }),
    });

    await app.database.tx((tx) => app.queue.enqueue(tx, { organizationId: ownerOrgId, type: "healthy", maxAttempts: 1 }));
    assert.equal(await reaper.runOnce(), true, "a failed reaper callback does not prevent claiming healthy work");
    assert.equal(healthy.commits.length, 1, "healthy job completed while the exhausted analysis could not be finalized");
    const rolledBack = await job(poisonId);
    assert.equal(rolledBack?.status, "running", "the failed transaction did not partially mark the job dead");
    assert.equal(rolledBack?.locked_by, "crashed-worker");
    const analysisDuringRetry = (await app.testDb.query<{ status: string; error_code: string | null; completed_at: string | null }>(
      "SELECT status, error_code, completed_at FROM incident_analyses WHERE organization_id = $1 AND id = $2", [ownerOrgId, analysisId],
    ))[0];
    assert.equal(analysisDuringRetry?.status, "running", "analysis still matches its recoverable running job");
    assert.equal(analysisDuringRetry?.error_code, null);
    assert.equal(analysisDuringRetry?.completed_at, null);
    assert.ok(logs.some((entry) => entry.message.includes("continuing to claim work")), "poisoned finalization is observable");

    assert.equal(await reaper.runOnce(), false, "a repeated failure is isolated even when no additional work is queued");
    assert.equal((await job(poisonId))?.status, "running", "repeated callback failures do not partially finalize the lease");
    assert.equal((await app.testDb.query<{ status: string }>("SELECT status FROM incident_analyses WHERE organization_id = $1 AND id = $2", [ownerOrgId, analysisId]))[0]?.status, "running");

    assert.equal(await reaper.runOnce(), false, "a later successful finalization completes the reaping transaction");
    assert.equal((await job(poisonId))?.status, "dead");
    const failedAnalysis = (await app.testDb.query<{ status: string; error_code: string | null; completed_at: string | null }>(
      "SELECT status, error_code, completed_at FROM incident_analyses WHERE organization_id = $1 AND id = $2", [ownerOrgId, analysisId],
    ))[0];
    assert.equal(failedAnalysis?.status, "failed");
    assert.equal(failedAnalysis?.error_code, "timeout");
    assert.ok(failedAnalysis?.completed_at);
    assert.equal(notificationAttempts, 3);
  });

  it("a poisoned exhausted job at the head of the line does not block finalizing other exhausted jobs", async () => {
    const poisonType = "poison_finalizer";
    const goodType = "good_finalizer";
    const finalized: string[] = [];
    const poisonHandler = scripted(poisonType).handler;
    const goodHandler = scripted(goodType).handler;
    const poisoned: JobHandler<null> = {
      ...poisonHandler,
      async onFailure() {
        throw new Error("simulated permanently poisoned finalization");
      },
    };
    const good: JobHandler<null> = {
      ...goodHandler,
      async onFailure(tx, failed, error, final) {
        finalized.push(failed.id);
        await goodHandler.onFailure(tx, failed, error, final);
      },
    };

    const poisonId = await enqueue(poisonType, 1);
    const goodId = await enqueue(goodType, 1);
    assert.equal((await app.queue.claim("crashed-a", 60))?.id, poisonId);
    assert.equal((await app.queue.claim("crashed-b", 60))?.id, goodId);
    // The poisoned job expired EARLIER, so it sorts first: the head of the line.
    await app.testDb.query("UPDATE jobs SET locked_until = now() - interval '2 minutes' WHERE id = $1", [poisonId]);
    await app.testDb.query("UPDATE jobs SET locked_until = now() - interval '1 minute' WHERE id = $1", [goodId]);

    const logs: string[] = [];
    const reaper = new JobWorker(app.database, app.queue, [poisoned, good], {
      workerId: "w-reaper",
      leaseSeconds: 60,
      pollIntervalMs: 10,
      backoffSeconds: () => 0,
      log: (message) => logs.push(message),
    });
    for (let i = 0; i < 3; i++) await reaper.runOnce();

    assert.equal((await job(goodId))?.status, "dead", "the healthy exhausted job is finalized despite the poisoned one ahead of it");
    assert.deepEqual(finalized, [goodId], "the healthy job's owner is notified exactly once");
    const stuck = await job(poisonId);
    assert.equal(stuck?.status, "running", "the poisoned job stays recoverable (rolled back, not half-finalized)");
    assert.equal(stuck?.locked_by, "crashed-a");
    assert.ok(logs.some((m) => m.includes("continuing to claim work")), "each poisoned pass is logged");
  });

  it("database constraints: a running job must hold a lease; types and payloads are validated", async () => {
    const id = await enqueue();
    await assert.rejects(app.testDb.query("UPDATE jobs SET status = 'running' WHERE id = $1", [id]));
    await assert.rejects(app.testDb.query("INSERT INTO jobs (organization_id, type) VALUES ($1, 'Bad Type!')", [orgId]));
    await assert.rejects(app.testDb.query("INSERT INTO jobs (organization_id, type, payload) VALUES ($1, 'ok', '[]'::jsonb)", [orgId]));
  });
});

describe("exponentialBackoff", () => {
  it("doubles per attempt and is capped", () => {
    const f = exponentialBackoff(5, 60);
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(f), [5, 10, 20, 40, 60, 60]);
  });
});
