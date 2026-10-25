import assert from "node:assert/strict";
import { AppError } from "../common/errors";
import { GithubIssueService } from "../github/github-issue.service";
import { ServiceCatalogService } from "./service-catalog.service";
import { createTestApp, type TestApp } from "../test-support/app-harness";

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

describe("service catalog, change events, and GitHub tenant boundaries (real PostgreSQL)", () => {
  let app: TestApp;
  let services: ServiceCatalogService;
  let github: GithubIssueService;
  beforeEach(async () => {
    app = await createTestApp();
    services = new ServiceCatalogService(app.database);
    github = new GithubIssueService(app.database, async () => { throw new Error("GitHub network must be mocked in tests"); });
  });
  afterEach(async () => { await app.close(); });

  it("auto-links Alertmanager incidents by bounded service label without bumping the new incident version", async () => {
    const owner = await app.register("service-alert-owner@example.test");
    const organizationId = owner.auth.organizationId;
    assert.ok(organizationId, "registered owner must have an organization ID");
    const service = await services.create(owner.auth, { name: "checkout", ownerTeam: "payments", tier: "tier1" });
    const created = await app.database.tx((tx) => app.incidents.createFromAlert(tx, {
      organizationId,
      title: "Checkout latency alert",
      description: "created by test",
      severity: "sev2",
      serviceName: " checkout ",
      actor: { userId: null, displayName: "alertmanager: test" },
      eventPayload: { source: "test" },
    }));
    const incident = await app.incidents.get(owner.auth, created.id);
    const stored = await app.database.query<{ service_id: string | null }>(
      "SELECT service_id FROM incidents WHERE organization_id = $1 AND id = $2", [owner.auth.organizationId, created.id],
    );
    assert.equal(stored.rows[0]?.service_id, service.id);
    assert.equal(incident.version, 1, "service association belongs to the initial insert, not a second versioned update");
  });

  it("links incidents to same-tenant services and rejects viewers and cross-tenant links", async () => {
    const ownerA = await app.register("service-owner-a@example.test");
    const viewerA = await app.join(ownerA, "service-viewer-a@example.test", "viewer");
    const ownerB = await app.register("service-owner-b@example.test");
    const serviceA = await services.create(ownerA.auth, { name: "checkout", ownerTeam: "payments", tier: "tier1" });
    const serviceB = await services.create(ownerB.auth, { name: "checkout", ownerTeam: "platform", tier: "tier2" });
    const incidentA = await app.incidents.create(ownerA.auth, { title: "Checkout down", description: "", severity: "sev1" });
    const incidentB = await app.incidents.create(ownerB.auth, { title: "Checkout down in B", description: "", severity: "sev2" });

    assert.equal((await appError(services.create(viewerA.auth, { name: "forbidden", ownerTeam: "x" }))).code, "FORBIDDEN");
    await services.linkIncident(ownerA.auth, incidentA.id, { serviceId: serviceA.id });
    assert.equal((await services.incidentContext(ownerA.auth, incidentA.id)).service?.id, serviceA.id);
    assert.equal((await appError(services.remove(ownerA.auth, serviceA.id))).code, "CONFLICT", "deleting a linked service must not silently change an incident without an audit event");
    assert.equal((await services.incidentContext(ownerA.auth, incidentA.id)).service?.id, serviceA.id);
    assert.equal((await appError(services.linkIncident(ownerA.auth, incidentA.id, { serviceId: serviceB.id }))).code, "NOT_FOUND");
    assert.equal((await appError(services.linkIncident(ownerA.auth, incidentB.id, { serviceId: serviceA.id }))).code, "NOT_FOUND");
    assert.equal((await services.incidentContext(ownerB.auth, incidentB.id)).service, null);
  });

  it("deduplicates concurrent deliveries and correlates only same-service changes in the preceding 24 hours", async () => {
    const owner = await app.register("change-owner@example.test");
    const checkout = await services.create(owner.auth, { name: "checkout", ownerTeam: "payments", tier: "tier1" });
    await services.create(owner.auth, { name: "search", ownerTeam: "discovery", tier: "tier2" });
    const incident = await app.incidents.create(owner.auth, { title: "Checkout unavailable", description: "", severity: "sev1" });
    await services.linkIncident(owner.auth, incident.id, { serviceId: checkout.id });
    const integration = await app.integrations.create(owner.auth, { name: "change-ci", kind: "change-events" });
    const current = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const send = (service: string, externalId: string, timestamp: string) => services.ingestChange(integration.token, "127.0.0.1", async () => ({
      service, source: "ci", externalId, version: "build-42", actor: "release-bot", timestamp,
    }));

    const eventTime = current(5);
    const concurrent = await Promise.all([
      send("checkout", "deploy-current", eventTime),
      send("checkout", "deploy-current", eventTime),
    ]);
    assert.equal(concurrent.filter((r) => !r.duplicate).length, 1);
    assert.equal(concurrent.filter((r) => r.duplicate).length, 1);
    assert.equal(concurrent[0]?.changeEventId, concurrent[1]?.changeEventId);
    const used = await app.testDb.query<{ last_used_at: string | null }>("SELECT last_used_at FROM integrations WHERE id = $1", [integration.id]);
    assert.ok(used[0]?.last_used_at, "a successfully accepted change-event delivery updates the integration's Last used hint");

    await send("checkout", "deploy-25h", current(25 * 60));
    await send("search", "search-deploy", current(2));

    const context = await services.incidentContext(owner.auth, incident.id);
    assert.deepEqual(context.changes.map((change) => change.externalId), ["deploy-current"]);
    assert.equal(context.changes[0]?.correlationLabel, "correlation, not proven cause");
    const timeline = await app.incidents.timeline(owner.auth, incident.id, {});
    assert.equal(timeline.filter((event) => event.type === "change_context").length, 1, "a committed matching change flows through the incident-events notification path");

    const table = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM change_events WHERE organization_id = $1", [owner.auth.organizationId]);
    assert.equal(table[0]?.n, "3", "three distinct ids recorded; the retry was idempotent");
  });

  it("keeps GitHub issue links inside both the session tenant and its repository allow-list", async () => {
    const ownerA = await app.register("github-owner-a@example.test");
    const ownerB = await app.register("github-owner-b@example.test");
    await github.updateSettings(ownerA.auth, { enabled: true });
    await github.updateSettings(ownerB.auth, { enabled: true });
    const repoA = await github.addRepository(ownerA.auth, { owner: "acme", repo: "ops-a" });
    const repoB = await github.addRepository(ownerB.auth, { owner: "acme", repo: "ops-b" });
    const incidentA = await app.incidents.create(ownerA.auth, { title: "Ops A outage", description: "", severity: "sev2" });
    const incidentB = await app.incidents.create(ownerB.auth, { title: "Ops B outage", description: "", severity: "sev2" });

    const linked = await github.linkIssue(ownerA.auth, incidentA.id, { repositoryId: repoA.id, issueNumber: 7 });
    assert.equal(linked.link?.repository.id, repoA.id);
    assert.equal((await appError(github.linkIssue(ownerA.auth, incidentA.id, { repositoryId: repoB.id, issueNumber: 7 }))).code, "NOT_FOUND");
    assert.equal((await appError(github.linkIssue(ownerA.auth, incidentB.id, { repositoryId: repoA.id, issueNumber: 8 }))).code, "NOT_FOUND");
    assert.equal((await github.context(ownerB.auth, incidentB.id)).link, null);
  });

  it("rejects alert credentials before reading the change webhook body, enforces time bounds, and keeps GitHub settings tenant-scoped", async () => {
    const ownerA = await app.register("settings-owner-a@example.test");
    const ownerB = await app.register("settings-owner-b@example.test");
    const alertCredential = await app.integrations.create(ownerA.auth, { name: "alerts-only", kind: "alertmanager" });
    let bodyRead = false;
    assert.equal((await appError(services.ingestChange(alertCredential.token, "127.0.0.1", async () => { bodyRead = true; return {}; }))).code, "UNAUTHENTICATED");
    assert.equal(bodyRead, false);

    const changeCredential = await app.integrations.create(ownerA.auth, { name: "changes-only", kind: "change-events" });
    const service = await services.create(ownerA.auth, { name: "checkout", ownerTeam: "payments" });
    const outOfRange = (hours: number) => new Date(Date.now() - hours * 60 * 60_000).toISOString();
    await assert.rejects(services.ingestChange(changeCredential.token, "127.0.0.1", async () => ({
      service: service.name, source: "ci", externalId: "too-old", version: "v1", actor: "bot", timestamp: outOfRange(31 * 24),
    })), (error: unknown) => error instanceof AppError && error.code === "VALIDATION_FAILED");

    await assert.rejects(services.ingestChange(changeCredential.token, "127.0.0.1", async () => ({
      service: service.name, source: "ci", externalId: "impossible-calendar-date", version: "v1", actor: "bot", timestamp: "2026-09-31T12:00:00Z",
    })), (error: unknown) => error instanceof AppError && error.code === "VALIDATION_FAILED");

    await github.updateSettings(ownerA.auth, { enabled: true });
    const repository = await github.addRepository(ownerA.auth, { owner: "acme", repo: "public-ops" });
    assert.equal((await github.settings(ownerA.auth)).repositories[0]?.id, repository.id);
    assert.equal((await github.settings(ownerB.auth)).repositories.length, 0);
    assert.equal((await appError(github.updateSettings((await app.join(ownerA, "github-viewer@example.test", "viewer")).auth, { enabled: true }))).code, "FORBIDDEN");
  });
});
