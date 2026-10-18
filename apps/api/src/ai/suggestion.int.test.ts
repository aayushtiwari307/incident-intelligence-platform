import assert from "node:assert/strict";
import { ProviderError } from "../analysis/provider";
import { AppError } from "../common/errors";
import { createTestApp, type RegisteredUser, type TestApp } from "../test-support/app-harness";
import { FakeSuggestionProvider, type SuggestionProviderRequest } from "./suggestion-provider";

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

const NEW = { title: "Checkout database pool saturated", description: "Connections maxed out during the sale", severity: "sev2" } as const;
const KEY = ["sk", "live", "abcdefghijklmnop1234"].join("-"); // built at runtime so no key-shaped literal sits in the repo

describe("grounded AI suggestions (real PostgreSQL, fake provider only)", () => {
  let app: TestApp;
  let owner: RegisteredUser;
  afterEach(async () => {
    await app?.close();
  });

  const start = async (provider?: FakeSuggestionProvider, options: { dailyLimit?: number; optIn?: boolean } = {}) => {
    app = await createTestApp({ suggestionProvider: provider, aiDailyLimit: options.dailyLimit });
    owner = await app.register("o@example.com", "Org", "Olivia");
    if (provider && options.optIn !== false) await app.aiSuggestions.updateSettings(owner.auth, { suggestionsEnabled: true });
    return owner;
  };
  const count = async (sql: string) => Number((await app.testDb.query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`))[0]?.n);
  const used = async () => Number((await app.testDb.query<{ n: string }>("SELECT coalesce(sum(requests_used), 0) AS n FROM organization_ai_usage"))[0]?.n);
  const drain = async () => {
    await app.testDb.query("UPDATE jobs SET run_at = now()");
    while (await app.worker?.runOnce()) await app.testDb.query("UPDATE jobs SET run_at = now()");
  };
  const resolvedSimilar = async (user: RegisteredUser = owner) => {
    const old = await app.incidents.create(user.auth, { title: "Checkout database pool exhaustion", description: "Pool saturated during the sale", severity: "sev2" });
    await app.incidents.transition(user.auth, old.id, { to: "resolved", expectedVersion: old.version });
    await app.incidents.createResolution(user.auth, old.id, { rootCause: "Worker exhaustion", fixApplied: "Expanded the connection pool to 50" });
    return old;
  };
  const latest = async (incidentId: string) => (await app.aiSuggestions.state(owner.auth, incidentId)).items[0];

  it("server switch off: no provider call, no queue entry, no quota charge, and the API says why", async () => {
    await start(undefined);
    const inc = await app.incidents.create(owner.auth, NEW);
    const err = await appError(app.aiSuggestions.request(owner.auth, inc.id));
    assert.equal(err.code, "FEATURE_DISABLED");
    assert.deepEqual(err.details, { reason: "server_disabled" });
    assert.equal(await count("jobs"), 0);
    assert.equal(await count("ai_suggestions"), 0);
    assert.equal(await used(), 0);
    assert.equal((await app.aiSuggestions.state(owner.auth, inc.id)).settings.unavailableReason, "server_disabled");
  });

  it("organization not opted in: refused before anything is charged or queued", async () => {
    const provider = new FakeSuggestionProvider();
    await start(provider, { optIn: false });
    const inc = await app.incidents.create(owner.auth, NEW);
    const err = await appError(app.aiSuggestions.request(owner.auth, inc.id));
    assert.equal(err.code, "FEATURE_DISABLED");
    assert.deepEqual(err.details, { reason: "org_not_opted_in" });
    assert.equal(await count("ai_suggestions"), 0);
    assert.equal(await used(), 0);
    assert.equal(provider.requests.length, 0);
  });

  it("roles: viewers cannot generate, responders cannot configure, admins can; toggling is idempotent and audited once", async () => {
    const provider = new FakeSuggestionProvider();
    await start(provider, { optIn: false });
    const viewer = await app.join(owner, "v@example.com", "viewer");
    const responder = await app.join(owner, "r@example.com", "responder");
    const admin = await app.join(owner, "a@example.com", "admin");
    const inc = await app.incidents.create(owner.auth, NEW);

    assert.equal((await appError(app.aiSuggestions.updateSettings(responder.auth, { suggestionsEnabled: true }))).code, "FORBIDDEN");
    assert.equal((await appError(app.aiSuggestions.updateSettings(viewer.auth, { suggestionsEnabled: true }))).code, "FORBIDDEN");
    assert.equal((await appError(app.aiSuggestions.updateSettings(admin.auth, { suggestionsEnabled: "yes" }))).code, "VALIDATION_FAILED");
    assert.equal((await app.aiSuggestions.updateSettings(admin.auth, { suggestionsEnabled: true })).organizationOptIn, true);
    await app.aiSuggestions.updateSettings(admin.auth, { suggestionsEnabled: true });
    assert.equal(await count("ai_audit_events WHERE type = 'ai_settings_changed'"), 1, "no entry for a no-op");

    assert.equal((await appError(app.aiSuggestions.request(viewer.auth, inc.id))).code, "FORBIDDEN");
    assert.equal((await app.aiSuggestions.state(viewer.auth, inc.id)).items.length, 0, "viewers can read");
    assert.equal((await app.aiSuggestions.request(responder.auth, inc.id)).items[0]?.status, "queued");
  });

  it("happy path: queued, then a validated pending suggestion with citations that resolve to same-organization incidents", async () => {
    const provider = new FakeSuggestionProvider();
    await start(provider);
    const old = await resolvedSimilar();
    const inc = await app.incidents.create(owner.auth, NEW);
    const queued = await app.aiSuggestions.request(owner.auth, inc.id);
    assert.equal(queued.items[0]?.status, "queued");
    assert.equal(queued.settings.usedToday, 1);
    await drain();

    const s = await latest(inc.id);
    assert.equal(s?.status, "pending");
    assert.equal(s?.model, "fake-grounded-1");
    assert.equal(s?.promptVersion, "grounded-suggestion-v1");
    assert.ok(s?.content?.relatedIncidents.some((r) => r.incidentId === old.id));
    assert.equal(s?.sources[old.id]?.title, "Checkout database pool exhaustion");
    assert.equal(provider.requests.length, 1);
    assert.equal(await used(), 1);
    // Nothing about the incident changed.
    const after = await app.incidents.get(owner.auth, inc.id);
    assert.equal(after.version, inc.version);
    assert.equal(after.severity, "sev2");
  });

  it("the provider only receives aliases and redacted text: no ids, emails, names or secrets", async () => {
    const provider = new FakeSuggestionProvider();
    await start(provider);
    await resolvedSimilar();
    const inc = await app.incidents.create(owner.auth, { ...NEW, description: `Page ops@corp.io, key ${KEY}, password=hunter2-correct-horse` });
    await app.aiSuggestions.request(owner.auth, inc.id);
    await drain();
    const sent = JSON.stringify(provider.requests[0]?.user);
    for (const forbidden of ["ops@corp.io", KEY, "hunter2", inc.id, owner.auth.userId, "Olivia", "o@example.com"]) assert.ok(!sent.includes(forbidden), `leaked ${forbidden.slice(0, 6)}`);
    assert.ok(sent.includes("REDACTED"));
  });

  it("20 parallel requests against a limit of 5 create exactly 5 suggestions and charge exactly 5", async () => {
    const provider = new FakeSuggestionProvider();
    await start(provider, { dailyLimit: 5 });
    const incidents = await Promise.all(Array.from({ length: 20 }, (_, i) => app.incidents.create(owner.auth, { ...NEW, title: `Incident ${i}` })));
    const results = await Promise.allSettled(incidents.map((i) => app.aiSuggestions.request(owner.auth, i.id)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
    for (const r of results) if (r.status === "rejected") assert.equal((r.reason as AppError).code, "RATE_LIMITED");
    assert.equal(await used(), 5);
    assert.equal(await count("ai_suggestions"), 5);
    assert.equal(await count("jobs WHERE type = 'generate_ai_suggestion'"), 5);
  });

  it("the daily limit is a hard stop with Retry-After and a reason, and viewers still see the state", async () => {
    await start(new FakeSuggestionProvider(), { dailyLimit: 1 });
    const a = await app.incidents.create(owner.auth, NEW);
    const b = await app.incidents.create(owner.auth, { ...NEW, title: "Another" });
    await app.aiSuggestions.request(owner.auth, a.id);
    const err = await appError(app.aiSuggestions.request(owner.auth, b.id));
    assert.equal(err.code, "RATE_LIMITED");
    assert.deepEqual(err.details, { reason: "quota_exhausted" });
    assert.ok(Number(err.headers?.["Retry-After"]) > 0);
    assert.equal((await app.aiSuggestions.state(owner.auth, b.id)).settings.unavailableReason, "quota_exhausted");
  });

  it("a duplicate in-flight request is a 409 and costs nothing", async () => {
    await start(new FakeSuggestionProvider());
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.aiSuggestions.request(owner.auth, inc.id);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => app.aiSuggestions.request(owner.auth, inc.id)));
    for (const r of results) {
      assert.equal(r.status, "rejected");
      assert.equal(((r as PromiseRejectedResult).reason as AppError).code, "CONFLICT");
    }
    assert.equal(await count("ai_suggestions"), 1);
    assert.equal(await used(), 1);
    assert.equal(await count("jobs"), 1);
  });

  it("the per-user rate limit applies before any charge", async () => {
    app = await createTestApp({ suggestionProvider: new FakeSuggestionProvider(), aiUserLimit: 1 });
    owner = await app.register("limit@example.com");
    await app.aiSuggestions.updateSettings(owner.auth, { suggestionsEnabled: true });
    const a = await app.incidents.create(owner.auth, NEW);
    const b = await app.incidents.create(owner.auth, { ...NEW, title: "Second" });
    await app.aiSuggestions.request(owner.auth, a.id);
    assert.equal((await appError(app.aiSuggestions.request(owner.auth, b.id))).code, "RATE_LIMITED");
    assert.equal(await used(), 1);
  });

  it("a retry inside one request is charged once; the provider is used at most twice", async () => {
    const provider = new FakeSuggestionProvider([
      () => {
        throw new ProviderError("provider_error", "HTTP 503", true);
      },
    ]);
    await start(provider);
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.aiSuggestions.request(owner.auth, inc.id);
    await drain();
    assert.equal((await latest(inc.id))?.status, "pending");
    assert.equal(provider.requests.length, 2);
    assert.equal(await used(), 1);
  });

  it("a permanent provider failure ends failed, stays charged (the provider was reached), and leaks nothing", async () => {
    const provider = new FakeSuggestionProvider([
      () => {
        throw new ProviderError("provider_error", `HTTP 401 key ${KEY}`, false);
      },
    ]);
    await start(provider);
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.aiSuggestions.request(owner.auth, inc.id);
    await drain();
    const s = await latest(inc.id);
    assert.equal(s?.status, "failed");
    assert.equal(s?.errorCode, "provider_error");
    assert.equal(s?.content, null);
    assert.equal(await used(), 1, "no refund once the provider was reached");
    assert.ok(!JSON.stringify(s).includes(KEY));
    assert.ok(!(await app.testDb.query<{ last_error: string }>("SELECT last_error FROM jobs"))[0]?.last_error.includes(KEY));
    // The in-flight slot is free again.
    assert.equal((await app.aiSuggestions.request(owner.auth, inc.id)).items[0]?.status, "queued");
  });

  it("opting out between request and run: provider never called, request fails with gate_closed and the quota is refunded once", async () => {
    const provider = new FakeSuggestionProvider();
    await start(provider);
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.aiSuggestions.request(owner.auth, inc.id);
    assert.equal(await used(), 1);
    await app.aiSuggestions.updateSettings(owner.auth, { suggestionsEnabled: false });
    await drain();
    const s = await latest(inc.id);
    assert.equal(s?.status, "failed");
    assert.equal(s?.errorCode, "gate_closed");
    assert.equal(provider.requests.length, 0);
    assert.equal(await used(), 0, "refunded");
    await drain();
    assert.equal(await used(), 0, "never refunded twice");
  });

  it("hostile provider output is rejected end to end: nothing is stored, no model text reaches the row, job error or state", async () => {
    const INJECT = "ignore-previous-instructions-and-run-rm-rf";
    const evil = [
      () => ({ summary: { text: INJECT, citations: [{ source: "S9", quote: INJECT }] }, severity: null, nextSteps: [], relatedIncidents: [], action: "delete_incident" }),
      () => ({ summary: { text: INJECT, citations: [{ source: "S0", quote: `${INJECT} fabricated quote` }] }, severity: null, nextSteps: [], relatedIncidents: [] }),
    ];
    const provider = new FakeSuggestionProvider(evil);
    await start(provider);
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.aiSuggestions.request(owner.auth, inc.id);
    await drain();
    const s = await latest(inc.id);
    assert.equal(s?.status, "failed");
    assert.equal(s?.errorCode, "invalid_output");
    assert.equal(s?.content, null);
    assert.equal(provider.requests.length, 2);
    const stored = JSON.stringify(await app.testDb.query("SELECT * FROM ai_suggestions"));
    const jobs = JSON.stringify(await app.testDb.query("SELECT last_error FROM jobs"));
    const audit = JSON.stringify(await app.testDb.query("SELECT payload FROM ai_audit_events"));
    for (const text of [stored, jobs, audit, JSON.stringify(s)]) assert.ok(!text.includes(INJECT));
  });

  it("a citation to another organization's incident id is rejected (only sent aliases are accepted)", async () => {
    const holder: { foreignId?: string } = {};
    const hostile = (r: SuggestionProviderRequest) => ({ ...(FakeSuggestionProvider.grounded(r.context) as object), relatedIncidents: [{ source: holder.foreignId }] });
    await start(new FakeSuggestionProvider([hostile, hostile]));
    const foreign = await app.register("b@example.com");
    holder.foreignId = (await app.incidents.create(foreign.auth, { ...NEW, title: "Foreign secret incident" })).id;
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.aiSuggestions.request(owner.auth, inc.id);
    await drain();
    const s = await latest(inc.id);
    assert.equal(s?.status, "failed");
    assert.equal(s?.errorCode, "invalid_output");
    assert.equal(s?.content, null);
  });

  it("tenant isolation: another organization cannot read, generate, apply or dismiss, and the context never contains its incidents", async () => {
    const provider = new FakeSuggestionProvider();
    await start(provider);
    const foreign = await app.register("b@example.com");
    await app.aiSuggestions.updateSettings(foreign.auth, { suggestionsEnabled: true });
    await resolvedSimilar(foreign);
    const inc = await app.incidents.create(owner.auth, NEW);
    assert.equal((await appError(app.aiSuggestions.state(foreign.auth, inc.id))).code, "NOT_FOUND");
    assert.equal((await appError(app.aiSuggestions.request(foreign.auth, inc.id))).code, "NOT_FOUND");

    await app.aiSuggestions.request(owner.auth, inc.id);
    await drain();
    const s = await latest(inc.id);
    assert.equal(s?.status, "pending");
    assert.deepEqual(s?.content?.relatedIncidents, [], "the foreign organization's similar incident was never visible");
    assert.ok(!JSON.stringify(provider.requests[0]?.user).includes("Checkout database pool exhaustion"));
    assert.equal((await appError(app.aiSuggestions.apply(foreign.auth, inc.id, s?.id as string, { target: "comment" }))).code, "NOT_FOUND");
    assert.equal((await appError(app.aiSuggestions.dismiss(foreign.auth, inc.id, s?.id as string))).code, "NOT_FOUND");
  });

  it("apply is a DRAFT only: nothing about the incident changes, first apply is audited once, repeats return the same draft", async () => {
    await start(new FakeSuggestionProvider());
    await resolvedSimilar();
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.aiSuggestions.request(owner.auth, inc.id);
    await drain();
    const s = await latest(inc.id);
    const commentsBefore = await count("incident_events");

    const draft = await app.aiSuggestions.apply(owner.auth, inc.id, s?.id as string, { target: "comment" });
    assert.match(draft.commentBody ?? "", /^AI-suggested next steps \(draft, please review before posting\):/);
    assert.equal(draft.severity, null);
    const again = await app.aiSuggestions.apply(owner.auth, inc.id, s?.id as string, { target: "comment" });
    assert.equal(again.commentBody, draft.commentBody);
    const sev = await app.aiSuggestions.apply(owner.auth, inc.id, s?.id as string, { target: "severity" });
    assert.equal(sev.severity, "sev2");
    assert.equal(sev.suggestion.appliedTarget, "severity", "the recorded target follows the draft actually requested");

    const after = await app.incidents.get(owner.auth, inc.id);
    assert.equal(after.version, inc.version, "the incident is untouched");
    assert.equal(await count("incident_events"), commentsBefore, "no comment or other timeline event was created");
    assert.equal(await count("ai_audit_events WHERE type = 'suggestion_applied'"), 2, "changing the draft target is audited");
    assert.equal((await latest(inc.id))?.status, "applied");
    const targetChanges = await app.testDb.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM ai_audit_events WHERE type = 'suggestion_applied' ORDER BY id",
    );
    assert.deepEqual(targetChanges.map((r) => r.payload), [{ target: "comment" }, { from: "comment", target: "severity" }]);
    assert.equal((await appError(app.aiSuggestions.dismiss(owner.auth, inc.id, s?.id as string))).code, "CONFLICT");
  });

  it("dismiss: only a pending suggestion, audited once, and a viewer cannot", async () => {
    await start(new FakeSuggestionProvider());
    const viewer = await app.join(owner, "v@example.com", "viewer");
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.aiSuggestions.request(owner.auth, inc.id);
    const queued = await latest(inc.id);
    assert.equal((await appError(app.aiSuggestions.dismiss(owner.auth, inc.id, queued?.id as string))).code, "CONFLICT", "not ready yet");
    assert.equal((await appError(app.aiSuggestions.apply(owner.auth, inc.id, queued?.id as string, { target: "comment" }))).code, "CONFLICT");
    await drain();
    const s = await latest(inc.id);
    assert.equal((await appError(app.aiSuggestions.dismiss(viewer.auth, inc.id, s?.id as string))).code, "FORBIDDEN");
    assert.equal((await app.aiSuggestions.dismiss(owner.auth, inc.id, s?.id as string)).status, "dismissed");
    assert.equal(await count("ai_audit_events WHERE type = 'suggestion_dismissed'"), 1);
    assert.equal((await appError(app.aiSuggestions.apply(owner.auth, inc.id, s?.id as string, { target: "comment" }))).code, "CONFLICT");
    assert.equal((await appError(app.aiSuggestions.apply(owner.auth, inc.id, s?.id as string, { target: "email" }))).code, "VALIDATION_FAILED");
  });

  it("audit is append-only and carries identifiers and enums, never model text", async () => {
    await start(new FakeSuggestionProvider());
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.aiSuggestions.request(owner.auth, inc.id);
    await drain();
    const rows = await app.testDb.query<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload FROM ai_audit_events ORDER BY created_at");
    assert.deepEqual(rows.map((r) => r.type), ["ai_settings_changed", "suggestion_requested"]);
    await assert.rejects(app.testDb.query("UPDATE ai_audit_events SET type = 'suggestion_dismissed'"));
    await assert.rejects(app.testDb.query("DELETE FROM ai_audit_events"));
  });

  it("if the audit write fails, the whole request rolls back: no suggestion, no job, no quota charge", async () => {
    await start(new FakeSuggestionProvider());
    const inc = await app.incidents.create(owner.auth, NEW);
    await app.testDb.query(
      `CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'suggestion_requested' THEN RAISE EXCEPTION 'audit down'; END IF; RETURN NEW; END $$`,
    );
    await app.testDb.query("CREATE TRIGGER fail_audit_t BEFORE INSERT ON ai_audit_events FOR EACH ROW EXECUTE FUNCTION fail_audit()");
    await assert.rejects(app.aiSuggestions.request(owner.auth, inc.id));
    assert.equal(await count("ai_suggestions"), 0);
    assert.equal(await count("jobs"), 0);
    assert.equal(await used(), 0);
  });

  it("database constraints reject an inconsistent suggestion row", async () => {
    await start(new FakeSuggestionProvider());
    const inc = await app.incidents.create(owner.auth, NEW);
    await assert.rejects(
      app.testDb.query(
        "INSERT INTO ai_suggestions (organization_id, incident_id, incident_version, status, quota_date) VALUES ($1, $2, 1, 'pending', current_date)",
        [owner.auth.organizationId, inc.id],
      ),
      "a pending suggestion must carry content",
    );
    await assert.rejects(app.testDb.query("INSERT INTO ai_suggestions (organization_id, incident_id, incident_version, status, quota_date) VALUES ($1, $2, 1, 'bogus', current_date)", [owner.auth.organizationId, inc.id]));
  });
});
