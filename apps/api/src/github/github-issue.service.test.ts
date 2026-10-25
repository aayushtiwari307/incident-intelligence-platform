import assert from "node:assert/strict";
import { githubApiEndpoint, GithubIssueService } from "./github-issue.service";
import type { Database } from "../common/sql";

const ORG = "11111111-1111-4111-8111-111111111111";
const INCIDENT = "22222222-2222-4222-8222-222222222222";
const REPOSITORY = "33333333-3333-4333-8333-333333333333";
const LINK = "44444444-4444-4444-8444-444444444444";
const ORG_B = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-10-24T10:00:00.000Z");

interface LinkRow {
  id: string; organization_id: string; repository_id: string; repository_linked_at: string; issue_number: number;
  issue_etag: string | null; comments_etag: string | null; issue_snapshot: unknown; comments_snapshot: unknown;
  checked_at: string | null; refresh_after: string; failure_code: string | null; owner: string; repo: string;
}

class GithubDb {
  calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  row: LinkRow = {
    id: LINK, organization_id: ORG, repository_id: REPOSITORY, repository_linked_at: "2026-10-20T00:00:00.000Z", issue_number: 7,
    issue_etag: null, comments_etag: null, issue_snapshot: {}, comments_snapshot: [], checked_at: null,
    refresh_after: "1970-01-01T00:00:00.000Z", failure_code: null, owner: "acme", repo: "incident-tracker",
  };
  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    if (sql.includes("SELECT id FROM incidents")) return { rows: [{ id: INCIDENT } as T] };
    if (sql.includes("SELECT enabled FROM organization_github_settings")) return { rows: [{ enabled: true } as T] };
    if (sql.includes("FROM github_issue_links l")) return { rows: [{ ...this.row } as T] };
    if (sql.includes("UPDATE github_issue_links SET issue_etag")) {
      const updated: LinkRow = {
        ...this.row,
        issue_etag: params[2] as string | null,
        comments_etag: params[3] as string | null,
        issue_snapshot: JSON.parse(String(params[4])) as unknown,
        comments_snapshot: JSON.parse(String(params[5])) as unknown,
        checked_at: String(params[6]), refresh_after: String(params[7]), failure_code: params[8] as string | null,
        repository_linked_at: String(params[9]), owner: String(params[10]), repo: String(params[11]),
      };
      this.row = updated;
      return { rows: [{ ...updated } as T] };
    }
    if (sql.includes("UPDATE github_issue_links SET") && sql.includes("checked_at = $3::timestamptz")) {
      const failure = String(params[4]);
      const clearsPrivateSnapshot = sql.includes("issue_snapshot = CASE WHEN $5::text = 'not_found_or_private'");
      this.row = {
        ...this.row,
        ...(failure === "not_found_or_private" && clearsPrivateSnapshot ? {
          issue_etag: null, comments_etag: null, issue_snapshot: {}, comments_snapshot: [],
        } : {}),
        checked_at: String(params[2]), refresh_after: String(params[3]), failure_code: failure,
      };
      return { rows: [{ ...this.row } as T] };
    }
    return { rows: [] };
  }
}

const auth = { sessionId: "session", userId: "user", email: "a@example.test", displayName: "Test", organizationId: ORG, role: "owner" } as const;
const asDatabase = (db: GithubDb) => db as unknown as Database;

function apiResponse(status: number, value?: unknown, etag?: string): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: etag ? { etag, "content-type": "application/json" } : { "content-type": "application/json" },
  });
}

describe("githubApiEndpoint", () => {
  it("builds only HTTPS URLs on the fixed GitHub API origin", () => {
    assert.equal(githubApiEndpoint("acme", "incident-tracker", 7, "issue"), "https://api.github.com/repos/acme/incident-tracker/issues/7");
    assert.equal(githubApiEndpoint("acme", "incident-tracker", 7, "comments"), "https://api.github.com/repos/acme/incident-tracker/issues/7/comments?per_page=5&sort=created&direction=desc");
  });

  it("rejects path, host, query, and numeric injection in identifiers", () => {
    for (const owner of ["https://attacker.invalid", "../org", "a/b", "-starts-with-dash"]) {
      assert.throws(() => githubApiEndpoint(owner, "repo", 1, "issue"), /Invalid GitHub/);
    }
    for (const repo of ["..", "../other", "repo/path", "https://attacker.invalid"]) {
      assert.throws(() => githubApiEndpoint("owner", repo, 1, "issue"), /Invalid GitHub/);
    }
    for (const issue of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => githubApiEndpoint("owner", "repo", issue, "issue"), /Invalid GitHub/);
    }
  });
});

describe("GithubIssueService (mock network only)", () => {
  it("projects bounded public issue content, uses ETags, and caches the result", async () => {
    const db = new GithubDb();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      assert.equal(new URL(url).hostname, "api.github.com");
      assert.equal(init.redirect, "manual");
      assert.equal((init.headers as Record<string, string>).Authorization, undefined, "no GitHub token is sent");
      if (url.endsWith("/comments?per_page=5&sort=created&direction=desc")) {
        return apiResponse(200, [{ user: { login: "reporter" }, body: "comment\ntext", created_at: "2026-10-23T09:00:00Z" }], '"comments-v1"');
      }
      return apiResponse(200, {
        title: "Checkout\u202E unavailable", state: "closed", body: "  A summary\nwith controls  ", updated_at: "2026-10-23T10:00:00Z",
        labels: [{ name: "sev1", color: "AABBCC" }, { name: "bad", color: "not-a-color" }], assignee: { login: "on-call" }, pull_request: { url: "https://api.github.com/pulls/7" },
      }, '"issue-v1"');
    };
    const service = new GithubIssueService(asDatabase(db), fetchMock, () => new Date(NOW));
    const result = await service.context(auth, INCIDENT);
    assert.equal(result.status, "available");
    assert.equal(result.issue?.title, "Checkout unavailable");
    assert.equal(result.issue?.bodyExcerpt, "A summary with controls");
    assert.equal(result.issue?.isPullRequest, true);
    assert.deepEqual(result.issue?.labels, [{ name: "sev1", color: "aabbcc" }, { name: "bad", color: null }]);
    assert.equal(result.issue?.recentActivity[0]?.author, "reporter");
    assert.equal(result.link?.url, "https://github.com/acme/incident-tracker/issues/7");
    assert.equal(requests.length, 2);
    assert.equal((requests[0]?.init.headers as Record<string, string>)?.["If-None-Match"], undefined);

    const cached = await service.context(auth, INCIDENT);
    assert.equal(cached.status, "available");
    assert.equal(requests.length, 2, "fresh cache is used without another outbound request");
  });


  it("coalesces concurrent refreshes of the same issue link", async () => {
    const db = new GithubDb();
    let requests = 0;
    let unblockFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { unblockFirst = resolve; });
    const service = new GithubIssueService(asDatabase(db), async (input) => {
      requests += 1;
      if (requests === 1) { signalFirstStarted(); await firstGate; }
      if (String(input).includes("/comments?")) return apiResponse(200, [], '"comments-v1"');
      return apiResponse(200, { title: "issue", state: "open", updated_at: "2026-10-23T10:00:00Z", labels: [], assignee: null, body: "" }, '"issue-v1"');
    }, () => new Date(NOW));

    const first = service.context(auth, INCIDENT);
    const second = service.context(auth, INCIDENT);
    await firstStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 1, "the second reader must join the in-flight refresh rather than call GitHub again");
    unblockFirst();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, "available");
    assert.equal(b.status, "available");
    assert.equal(requests, 2, "one issue GET and one comments GET serve both readers");
  });

  it("retries an unconditional issue GET when a 304 arrives without a valid cached snapshot", async () => {
    const db = new GithubDb();
    db.row.issue_etag = '"stale-etag"';
    db.row.issue_snapshot = {}; // missing or invalid cached representation cannot satisfy a 304
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const service = new GithubIssueService(asDatabase(db), async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (requests.length === 1) return apiResponse(304);
      if (url.includes("/comments?")) return apiResponse(200, [], '"comments-v1"');
      return apiResponse(200, {
        title: "Recovered issue", state: "open", updated_at: "2026-10-23T10:00:00Z", labels: [], assignee: null, body: "fresh representation",
      }, '"fresh-etag"');
    }, () => new Date(NOW));

    const result = await service.context(auth, INCIDENT);
    assert.equal(result.status, "available");
    assert.equal(result.issue?.title, "Recovered issue");
    assert.equal(requests.length, 3, "304 without a cached representation triggers one unconditional issue request plus comments");
    assert.equal((requests[0]?.init.headers as Record<string, string>)?.["If-None-Match"], '"stale-etag"');
    assert.equal((requests[1]?.init.headers as Record<string, string>)?.["If-None-Match"], undefined);
  });

  it("does not resurrect a previously private issue after a later transient failure", async () => {
    const db = new GithubDb();
    db.row.issue_etag = '"private-etag"';
    db.row.comments_etag = '"private-comments"';
    db.row.issue_snapshot = { title: "Formerly public", state: "open", isPullRequest: false, labels: [], assignee: null, updatedAt: "2026-10-23T10:00:00.000Z", bodyExcerpt: "Sensitive cached body" };
    db.row.comments_snapshot = [{ author: "reporter", body: "Sensitive cached comment", createdAt: "2026-10-23T09:00:00.000Z" }];
    let calls = 0;
    const service = new GithubIssueService(asDatabase(db), async () => {
      calls += 1;
      return calls === 1 ? apiResponse(404) : apiResponse(503);
    }, () => new Date(NOW));

    const hidden = await service.context(auth, INCIDENT);
    assert.equal(hidden.status, "not_found_or_private");
    assert.equal(hidden.issue, null);
    assert.deepEqual(db.row.issue_snapshot, {});
    assert.deepEqual(db.row.comments_snapshot, []);
    assert.equal(db.row.issue_etag, null);
    assert.equal(db.row.comments_etag, null);

    db.row.refresh_after = "1970-01-01T00:00:00.000Z";
    const afterOutage = await service.context(auth, INCIDENT);
    assert.equal(afterOutage.status, "unavailable");
    assert.equal(afterOutage.issue, null, "a later outage must not reveal content previously hidden by a 404");
    assert.match(db.calls.find((call) => call.sql.includes("issue_snapshot = CASE"))?.sql ?? "", /not_found_or_private/);
  });

  it("caps total outbound GitHub API requests per process, not refresh operations", async () => {
    const db = new GithubDb();
    let requests = 0;
    const service = new GithubIssueService(asDatabase(db), async (input) => {
      requests += 1;
      if (String(input).includes("/comments?")) return apiResponse(200, [], '"comments-etag"');
      return apiResponse(200, { title: "issue", state: "open", updated_at: "2026-10-23T10:00:00Z", labels: [], assignee: null, body: "" }, '"issue-etag"');
    }, () => new Date(NOW));

    for (let i = 0; i < 25; i += 1) {
      const organizationId = i % 2 === 0 ? ORG : ORG_B;
      db.row.organization_id = organizationId;
      db.row.refresh_after = "1970-01-01T00:00:00.000Z";
      const result = await service.context({ ...auth, organizationId }, INCIDENT);
      assert.equal(result.status, "available");
    }
    assert.equal(requests, 50);
    db.row.organization_id = ORG;
    db.row.refresh_after = "1970-01-01T00:00:00.000Z";
    const throttled = await service.context(auth, INCIDENT);
    assert.equal(throttled.status, "rate_limited");
    assert.equal(requests, 50, "no 51st outbound request should be made");
  });

  it("counts each outbound request toward the per-organization budget", async () => {
    const db = new GithubDb();
    let requests = 0;
    const service = new GithubIssueService(asDatabase(db), async (input) => {
      requests += 1;
      if (String(input).includes("/comments?")) return apiResponse(200, [], '"comments-v1"');
      return apiResponse(200, { title: "issue", state: "open", updated_at: "2026-10-23T10:00:00Z", labels: [], assignee: null, body: "" }, '"issue-v1"');
    }, () => new Date(NOW));

    for (let i = 0; i < 15; i += 1) {
      db.row.refresh_after = "1970-01-01T00:00:00.000Z";
      assert.equal((await service.context(auth, INCIDENT)).status, "available");
    }
    assert.equal(requests, 30);
    db.row.refresh_after = "1970-01-01T00:00:00.000Z";
    assert.equal((await service.context(auth, INCIDENT)).status, "rate_limited");
    assert.equal(requests, 30, "the per-org budget counts individual HTTP requests, not refreshes");
  });

  it("sends conditional ETags and never follows a redirect to another host", async () => {
    const db = new GithubDb();
    db.row.issue_etag = '"old-issue"';
    db.row.comments_etag = '"old-comments"';
    db.row.issue_snapshot = { title: "Previously public", state: "open", isPullRequest: false, labels: [], assignee: null, updatedAt: "2026-10-23T10:00:00.000Z", bodyExcerpt: "Cached" };
    db.row.comments_snapshot = [{ author: "x", body: "cached", createdAt: "2026-10-23T09:00:00.000Z" }];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const service = new GithubIssueService(asDatabase(db), async (input, init = {}) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return apiResponse(304);
      return apiResponse(302, undefined);
    }, () => new Date(NOW));
    const result = await service.context(auth, INCIDENT);
    assert.equal(requests.length, 2);
    assert.equal((requests[0]?.init.headers as Record<string, string>)?.["If-None-Match"], '"old-issue"');
    assert.equal((requests[1]?.init.headers as Record<string, string>)?.["If-None-Match"], '"old-comments"');
    assert.equal(requests.every((request) => new URL(request.url).hostname === "api.github.com"), true);
    assert.equal(requests.every((request) => request.init.redirect === "manual"), true);
    assert.equal(result.status, "unavailable");
  });

  it("hides stale cached issue details when GitHub says the issue is private or missing", async () => {
    const db = new GithubDb();
    db.row.issue_snapshot = { title: "Formerly public", state: "open", isPullRequest: false, labels: [], assignee: null, updatedAt: "2026-10-23T10:00:00.000Z", bodyExcerpt: "Do not leak" };
    const service = new GithubIssueService(asDatabase(db), async () => apiResponse(404), () => new Date(NOW));
    const result = await service.context(auth, INCIDENT);
    assert.equal(result.status, "not_found_or_private");
    assert.equal(result.issue, null);
  });

  it("respects GitHub's reported remaining quota before making the next outbound request", async () => {
    const db = new GithubDb();
    let requests = 0;
    const resetSeconds = Math.floor(NOW.getTime() / 1000) + 120;
    const service = new GithubIssueService(asDatabase(db), async (input) => {
      requests += 1;
      assert.equal(String(input).includes("/comments?"), false, "comments request must be blocked after the quota reaches the reserve");
      return new Response(JSON.stringify({
        title: "Checkout issue", state: "open", updated_at: "2026-10-23T10:00:00Z", labels: [], assignee: null, body: "bounded context",
      }), { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "5", "x-ratelimit-reset": String(resetSeconds) } });
    }, () => new Date(NOW));

    const result = await service.context(auth, INCIDENT);
    assert.equal(requests, 1);
    assert.equal(result.status, "rate_limited");
    assert.equal(result.issue?.title, "Checkout issue", "useful issue data remains available when only comments are rate limited");
  });

  it("gracefully classifies GitHub rate limiting without logging or exposing the response body", async () => {
    const db = new GithubDb();
    const service = new GithubIssueService(asDatabase(db), async () => new Response("private response body", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), () => new Date(NOW));
    const result = await service.context(auth, INCIDENT);
    assert.equal(result.status, "rate_limited");
    assert.equal(result.issue, null);
    assert.equal(JSON.stringify(result).includes("private response body"), false);
  });
});
