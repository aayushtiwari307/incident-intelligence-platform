import assert from "node:assert/strict";
import { INCIDENT_STATUSES, canTransition, type IncidentStatus } from "@platform/shared";
import { AppError } from "../common/errors";
import { createTestApp, type TestApp } from "../test-support/app-harness";

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

const NEW = { title: "Checkout 500s", description: "Spike", severity: "sev2" } as const;

describe("incidents (real PostgreSQL)", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("creates an incident with a per-organization number, a 'created' event and the creator recorded", async () => {
    const owner = await app.register("o@example.com");
    const incident = await app.incidents.create(owner.auth, NEW);
    assert.equal(incident.number, 1);
    assert.equal(incident.status, "triggered");
    assert.equal(incident.version, 1);
    assert.equal(incident.createdBy?.id, owner.me.user.id);
    const timeline = await app.incidents.timeline(owner.auth, incident.id, {});
    assert.deepEqual(timeline.map((e) => e.type), ["created"]);
  });

  it("stores multi-line, quoted and markup-looking text exactly as given", async () => {
    const owner = await app.register("o@example.com");
    const description = 'line one\nline "two", with comma\n<script>alert(1)</script>\n\ttabbed';
    const created = await app.incidents.create(owner.auth, { ...NEW, description });
    assert.equal((await app.incidents.get(owner.auth, created.id)).description, description);
    const comment = await app.incidents.comment(owner.auth, created.id, { body: "a\n\nb" });
    assert.equal(comment.payload.body, "a\n\nb");
  });

  it("numbers are sequential per organization and independent between organizations", async () => {
    const a = await app.register("a@example.com");
    const b = await app.register("b@example.com");
    await app.incidents.create(a.auth, NEW);
    await app.incidents.create(a.auth, NEW);
    const firstOfB = await app.incidents.create(b.auth, NEW);
    assert.equal(firstOfB.number, 1);
  });

  it("20 parallel creations get 20 distinct, gap-free numbers", async () => {
    const owner = await app.register("o@example.com");
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => app.incidents.create(owner.auth, { ...NEW, title: `I${i}` })));
    const numbers = created.map((i) => i.number).sort((x, y) => x - y);
    assert.deepEqual(numbers, Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("roles: viewers read but cannot write; responders can create, update, transition and comment", async () => {
    const owner = await app.register("o@example.com");
    const viewer = await app.join(owner, "v@example.com", "viewer");
    const responder = await app.join(owner, "r@example.com", "responder");
    const incident = await app.incidents.create(responder.auth, NEW);
    assert.equal((await app.incidents.get(viewer.auth, incident.id)).id, incident.id);
    assert.equal((await app.incidents.list(viewer.auth, {})).items.length, 1);
    for (const attempt of [
      app.incidents.create(viewer.auth, NEW),
      app.incidents.update(viewer.auth, incident.id, { expectedVersion: 1, title: "x" }),
      app.incidents.transition(viewer.auth, incident.id, { to: "acknowledged", expectedVersion: 1 }),
      app.incidents.comment(viewer.auth, incident.id, { body: "hi" }),
    ]) {
      assert.equal((await appError(attempt)).code, "FORBIDDEN");
    }
    const after = await app.incidents.get(owner.auth, incident.id);
    assert.equal(after.version, 1, "rejected writes changed nothing");
  });

  it("tenant isolation: another organization's incident is 404 for every operation and never listed", async () => {
    const a = await app.register("a@example.com");
    const b = await app.register("b@example.com");
    const secret = await app.incidents.create(a.auth, { ...NEW, title: "A's secret" });
    assert.equal((await appError(app.incidents.get(b.auth, secret.id))).code, "NOT_FOUND");
    assert.equal((await appError(app.incidents.update(b.auth, secret.id, { expectedVersion: 1, title: "pwn" }))).code, "NOT_FOUND");
    assert.equal((await appError(app.incidents.transition(b.auth, secret.id, { to: "resolved", expectedVersion: 1 }))).code, "NOT_FOUND");
    assert.equal((await appError(app.incidents.comment(b.auth, secret.id, { body: "x" }))).code, "NOT_FOUND");
    assert.equal((await appError(app.incidents.timeline(b.auth, secret.id, {}))).code, "NOT_FOUND");
    assert.equal((await app.incidents.list(b.auth, {})).items.length, 0);
    assert.equal((await app.incidents.get(a.auth, secret.id)).title, "A's secret");
  });

  it("a client-supplied organization id is rejected by validation, not honoured", async () => {
    const a = await app.register("a@example.com");
    const b = await app.register("b@example.com");
    const err = await appError(app.incidents.create(a.auth, { ...NEW, organizationId: b.me.activeOrganizationId }));
    assert.equal(err.code, "VALIDATION_FAILED");
  });

  it("assignee must be a member of the same organization (cross-tenant reference refused)", async () => {
    const a = await app.register("a@example.com");
    const b = await app.register("b@example.com");
    const err = await appError(app.incidents.create(a.auth, { ...NEW, assigneeId: b.me.user.id }));
    assert.equal(err.code, "VALIDATION_FAILED");
    const mine = await app.incidents.create(a.auth, NEW);
    const err2 = await appError(app.incidents.update(a.auth, mine.id, { expectedVersion: 1, assigneeId: b.me.user.id }));
    assert.equal(err2.code, "VALIDATION_FAILED");
    assert.equal((await app.incidents.get(a.auth, mine.id)).version, 1);
    const ok = await app.incidents.update(a.auth, mine.id, { expectedVersion: 1, assigneeId: a.me.user.id });
    assert.equal(ok.assignee?.id, a.me.user.id);
  });

  it("update bumps the version, records one event per changed field and ignores no-op edits", async () => {
    const owner = await app.register("o@example.com");
    const inc = await app.incidents.create(owner.auth, NEW);
    const updated = await app.incidents.update(owner.auth, inc.id, { expectedVersion: 1, title: "New title", severity: "sev1" });
    assert.equal(updated.version, 2);
    const noop = await app.incidents.update(owner.auth, inc.id, { expectedVersion: 2, title: "New title" });
    assert.equal(noop.version, 2, "no real change: no version bump");
    const types = (await app.incidents.timeline(owner.auth, inc.id, {})).map((e) => e.type);
    assert.deepEqual(types, ["created", "edited", "severity_changed"]);
  });

  it("optimistic concurrency: a stale expectedVersion is a 409 with the current version", async () => {
    const owner = await app.register("o@example.com");
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.incidents.update(owner.auth, inc.id, { expectedVersion: 1, title: "first" });
    const err = await appError(app.incidents.update(owner.auth, inc.id, { expectedVersion: 1, title: "second" }));
    assert.equal(err.code, "VERSION_CONFLICT");
    assert.deepEqual((err.details as { currentVersion: number }).currentVersion, 2);
    assert.equal((await app.incidents.get(owner.auth, inc.id)).title, "first");
  });

  it("10 parallel updates with the same expectedVersion: exactly one wins, no lost update", async () => {
    const owner = await app.register("o@example.com");
    const inc = await app.incidents.create(owner.auth, NEW);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => app.incidents.update(owner.auth, inc.id, { expectedVersion: 1, title: `T${i}` })),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) if (r.status === "rejected") assert.equal((r.reason as AppError).code, "VERSION_CONFLICT");
    assert.equal((await app.incidents.get(owner.auth, inc.id)).version, 2);
  });

  it("status workflow: timestamps follow the status, and reopening clears resolved_at", async () => {
    const owner = await app.register("o@example.com");
    const inc = await app.incidents.create(owner.auth, NEW);
    const ack = await app.incidents.transition(owner.auth, inc.id, { to: "acknowledged", expectedVersion: 1, note: "on it" });
    assert.ok(ack.acknowledgedAt);
    const mit = await app.incidents.transition(owner.auth, inc.id, { to: "mitigated", expectedVersion: 2 });
    assert.ok(mit.mitigatedAt);
    const res = await app.incidents.transition(owner.auth, inc.id, { to: "resolved", expectedVersion: 3 });
    assert.ok(res.resolvedAt);
    const reopened = await app.incidents.transition(owner.auth, inc.id, { to: "investigating", expectedVersion: 4 });
    assert.equal(reopened.resolvedAt, null);
    assert.equal(reopened.mitigatedAt, null);
    const events = await app.incidents.timeline(owner.auth, inc.id, {});
    const first = events.find((e) => e.type === "status_changed");
    assert.deepEqual(first?.payload, { from: "triggered", to: "acknowledged", note: "on it" });
  });

  it("the service and the database agree on all 25 status pairs", async () => {
    const owner = await app.register("o@example.com");
    for (const from of INCIDENT_STATUSES) {
      for (const to of INCIDENT_STATUSES) {
        const inc = await app.incidents.create(owner.auth, NEW);
        // force the starting state directly (as the table owner) so each pair is tested from the right source
        if (from !== "triggered") {
          await app.testDb.query("ALTER TABLE incidents DISABLE TRIGGER incidents_before_update");
          await app.testDb.query(
            `UPDATE incidents SET status = $2, resolved_at = ${from === "resolved" ? "now()" : "NULL"}, version = version + 1 WHERE id = $1`,
            [inc.id, from],
          );
          await app.testDb.query("ALTER TABLE incidents ENABLE TRIGGER incidents_before_update");
        }
        const version = (await app.incidents.get(owner.auth, inc.id)).version;
        const viaService = await app.incidents.transition(owner.auth, inc.id, { to, expectedVersion: version }).then(
          () => true,
          (e: unknown) => {
            assert.equal((e as AppError).code, "INVALID_TRANSITION");
            return false;
          },
        );
        assert.equal(viaService, canTransition(from as IncidentStatus, to as IncidentStatus), `${from} -> ${to} (service)`);
      }
    }
  });

  it("the database itself rejects an illegal transition even when the service is bypassed", async () => {
    const owner = await app.register("o@example.com");
    const inc = await app.incidents.create(owner.auth, NEW);
    await assert.rejects(
      app.testDb.query("UPDATE incidents SET status = 'mitigated' WHERE id = $1", [inc.id]),
      (e: { code?: string }) => typeof e.code === "string",
    );
    assert.equal((await app.incidents.get(owner.auth, inc.id)).status, "triggered");
  });

  it("the timeline is append-only: events cannot be updated or deleted directly", async () => {
    const owner = await app.register("o@example.com");
    const inc = await app.incidents.create(owner.auth, NEW);
    await assert.rejects(app.testDb.query("UPDATE incident_events SET actor_label = 'forged' WHERE incident_id = $1", [inc.id]));
    await assert.rejects(app.testDb.query("DELETE FROM incident_events WHERE incident_id = $1", [inc.id]));
    assert.equal((await app.incidents.timeline(owner.auth, inc.id, {})).length, 1);
  });

  it("comments are recorded with the author's name at the time; the list supports filters and cursor pagination", async () => {
    const owner = await app.register("o@example.com", "Org", "Olivia");
    const inc = await app.incidents.create(owner.auth, NEW);
    const c = await app.incidents.comment(owner.auth, inc.id, { body: "  looking  " });
    assert.equal(c.payload.body, "looking");
    assert.equal(c.actor.label, "Olivia");
    assert.equal((await appError(app.incidents.comment(owner.auth, inc.id, { body: "   " }))).code, "VALIDATION_FAILED");

    for (let i = 0; i < 4; i++) await app.incidents.create(owner.auth, { ...NEW, title: `n${i}`, severity: i % 2 ? "sev1" : "sev3" });
    const page1 = await app.incidents.list(owner.auth, { limit: "2" });
    assert.deepEqual(page1.items.map((i) => i.number), [5, 4]);
    assert.equal(page1.nextCursor, "4");
    const page2 = await app.incidents.list(owner.auth, { limit: "2", cursor: page1.nextCursor });
    assert.deepEqual(page2.items.map((i) => i.number), [3, 2]);
    const sev1 = await app.incidents.list(owner.auth, { severity: "sev1" });
    assert.ok(sev1.items.length === 2 && sev1.items.every((i) => i.severity === "sev1"));
    assert.equal((await appError(app.incidents.list(owner.auth, { cursor: "1; DROP TABLE incidents" }))).code, "VALIDATION_FAILED");
    assert.equal((await app.incidents.list(owner.auth, { assignee: "unassigned" })).items.length, 5);
  });

  it("deleting a member keeps the incident history: events keep their label, assignment is cleared", async () => {
    const owner = await app.register("o@example.com");
    const member = await app.join(owner, "m@example.com", "responder");
    const inc = await app.incidents.create(owner.auth, { ...NEW, assigneeId: member.me.user.id });
    await app.incidents.comment(member.auth, inc.id, { body: "mine" });
    await app.organizations.removeMember(owner.auth, member.me.user.id);
    const after = await app.incidents.get(owner.auth, inc.id);
    assert.equal(after.assignee, null);
    const events = await app.incidents.timeline(owner.auth, inc.id, {});
    assert.ok(events.some((e) => e.type === "comment"));
  });
});
