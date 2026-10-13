import assert from "node:assert/strict";
import { Client } from "pg";
import { INCIDENT_EVENTS_CHANNEL, parseEventNotification, type EventNotification } from "./notification";
import { createTestApp, type TestApp, type RegisteredUser } from "../test-support/app-harness";

/** The data layer under the real-time feature, against a real PostgreSQL: session re-checks, tenant-filtered loads, the NOTIFY trigger. */
describe("real-time data layer (real PostgreSQL)", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  const sessionIdOf = (user: RegisteredUser): string => user.auth.sessionId;

  describe("AuthService.resolveSessions agrees with authenticate()", () => {
    async function assertParity(user: RegisteredUser, expectValid: boolean): Promise<void> {
      const single = await app.auth.authenticate(user.token);
      const batch = (await app.auth.resolveSessions([sessionIdOf(user)])).get(sessionIdOf(user));
      if (!expectValid) {
        assert.equal(single, null);
        assert.equal(batch, undefined);
        return;
      }
      assert.ok(single && batch);
      assert.equal(batch.userId, single.userId);
      assert.equal(batch.organizationId, single.organizationId);
      assert.equal(batch.role, single.role);
    }

    it("valid session", async () => {
      await assertParity(await app.register("p1@example.com"), true);
    });

    it("revoked session", async () => {
      const user = await app.register("p2@example.com");
      await app.auth.logout(user.auth);
      await assertParity(user, false);
    });

    it("expired session", async () => {
      const user = await app.register("p3@example.com");
      await app.testDb.query("UPDATE auth_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1", [sessionIdOf(user)]);
      await assertParity(user, false);
    });

    it("disabled user", async () => {
      const user = await app.register("p4@example.com");
      await app.testDb.query("UPDATE users SET disabled_at = now() WHERE id = $1", [user.auth.userId]);
      await assertParity(user, false);
    });

    it("member removed from the session's active organization (organization cleared, role absent)", async () => {
      const owner = await app.register("p5-owner@example.com");
      const member = await app.join(owner, "p5-member@example.com", "viewer");
      await app.organizations.removeMember(owner.auth, member.auth.userId);
      const single = await app.auth.authenticate(member.token);
      const batch = (await app.auth.resolveSessions([sessionIdOf(member)])).get(sessionIdOf(member));
      assert.equal(batch?.role ?? null, single?.role ?? null);
      assert.equal(batch?.organizationId ?? null, single?.organizationId ?? null);
      assert.equal(batch?.role ?? null, null, "a removed member has no role");
    });

    it("organization switched", async () => {
      const owner = await app.register("p6-owner@example.com");
      const member = await app.join(owner, "p6-member@example.com", "responder");
      const me = await app.auth.me(member.auth);
      const personal = me.memberships.find((m) => m.organizationId !== owner.auth.organizationId);
      assert.ok(personal);
      await app.auth.switchOrganization(member.auth, personal.organizationId);
      const batch = (await app.auth.resolveSessions([sessionIdOf(member)])).get(sessionIdOf(member));
      assert.equal(batch?.organizationId, personal.organizationId);
      assert.equal(batch?.role, "owner");
    });

    it("unknown ids are absent; empty input and duplicate ids are fine", async () => {
      const user = await app.register("p7@example.com");
      assert.equal((await app.auth.resolveSessions([])).size, 0);
      assert.equal((await app.auth.resolveSessions(["00000000-0000-4000-8000-000000000000"])).size, 0);
      assert.equal((await app.auth.resolveSessions([sessionIdOf(user), sessionIdOf(user)])).size, 1);
    });
  });

  describe("IncidentService.loadRealtimeMessage", () => {
    it("returns the entry with the incident's current state", async () => {
      const owner = await app.register("l1@example.com");
      const incident = await app.incidents.create(owner.auth, { title: "Load me", severity: "sev3" });
      await app.incidents.transition(owner.auth, incident.id, { to: "acknowledged", expectedVersion: 1 });
      const events = await app.incidents.timeline(owner.auth, incident.id, {});
      const created = events.find((e) => e.type === "created");
      assert.ok(created);

      const message = await app.incidents.loadRealtimeMessage(owner.auth.organizationId as string, created.id);
      assert.ok(message);
      assert.equal(message.eventId, created.id);
      assert.equal(message.incidentId, incident.id);
      assert.equal(message.event.type, "created");
      assert.equal(message.incident.status, "acknowledged", "the snapshot is the incident as stored now, newer than the event");
      assert.equal(message.incident.version, 2);
    });

    it("is filtered by organization: another organization's entry id yields null, never its data", async () => {
      const a = await app.register("l2a@example.com");
      const b = await app.register("l2b@example.com");
      const incident = await app.incidents.create(a.auth, { title: "A only", severity: "sev1" });
      const [event] = await app.incidents.timeline(a.auth, incident.id, {});
      assert.ok(event);
      assert.equal(await app.incidents.loadRealtimeMessage(b.auth.organizationId as string, event.id), null);
      assert.ok(await app.incidents.loadRealtimeMessage(a.auth.organizationId as string, event.id));
    });

    it("returns null for an entry that does not exist", async () => {
      const owner = await app.register("l3@example.com");
      assert.equal(await app.incidents.loadRealtimeMessage(owner.auth.organizationId as string, 999_999), null);
    });
  });

  describe("incident_events NOTIFY trigger", () => {
    async function listen(): Promise<{ received: EventNotification[]; stop(): Promise<void> }> {
      const client = new Client({ connectionString: app.testDb.connectionString });
      await client.connect();
      const received: EventNotification[] = [];
      client.on("notification", (m) => {
        const parsed = m.channel === INCIDENT_EVENTS_CHANNEL && m.payload ? parseEventNotification(m.payload) : null;
        if (parsed) received.push(parsed);
      });
      await client.query(`LISTEN ${INCIDENT_EVENTS_CHANNEL}`);
      return { received, stop: () => client.end() };
    }
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

    it("notifies once per committed timeline entry, with only the entry id and organization", async () => {
      const owner = await app.register("n1@example.com");
      const listener = await listen();
      try {
        const incident = await app.incidents.create(owner.auth, { title: "Notify", severity: "sev2" });
        await app.incidents.comment(owner.auth, incident.id, { body: "hello" });
        await settle();
        const events = await app.incidents.timeline(owner.auth, incident.id, {});
        assert.deepEqual(
          listener.received.map((n) => n.eventId),
          events.map((e) => e.id),
        );
        assert.ok(listener.received.every((n) => n.organizationId === owner.auth.organizationId));
      } finally {
        await listener.stop();
      }
    });

    it("sends nothing when the transaction rolls back", async () => {
      const owner = await app.register("n2@example.com");
      const incident = await app.incidents.create(owner.auth, { title: "Rollback", severity: "sev3" });
      const listener = await listen();
      try {
        const session = await app.testDb.connect();
        try {
          await session.query("BEGIN");
          await session.query(
            "INSERT INTO incident_events (organization_id, incident_id, type, actor_label, payload) VALUES ($1, $2, 'comment', 'sql', '{}'::jsonb)",
            [owner.auth.organizationId, incident.id],
          );
          await session.query("ROLLBACK");
        } finally {
          await session.close();
        }
        await settle();
        assert.deepEqual(listener.received, []);
      } finally {
        await listener.stop();
      }
    });

    it("also covers timeline entries written by raw SQL paths (member removal unassigns incidents)", async () => {
      const owner = await app.register("n3-owner@example.com");
      const member = await app.join(owner, "n3-member@example.com", "responder");
      const incident = await app.incidents.create(owner.auth, { title: "Assigned", severity: "sev3", assigneeId: member.auth.userId });
      const listener = await listen();
      try {
        await app.organizations.removeMember(owner.auth, member.auth.userId);
        await settle();
        const events = await app.incidents.timeline(owner.auth, incident.id, {});
        const unassigned = events.find((e) => e.type === "assigned" && e.payload.reason === "member_removed");
        assert.ok(unassigned, "the removal wrote an audited unassignment");
        assert.ok(listener.received.some((n) => n.eventId === unassigned.id), "and it was announced");
      } finally {
        await listener.stop();
      }
    });
  });
});
