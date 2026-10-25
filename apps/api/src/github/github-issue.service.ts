import {
  githubOwnerSchema,
  githubRepoSchema,
  githubRepositorySchema,
  githubSettingsSchema,
  linkGithubIssueSchema,
  uuidSchema,
  type GithubIssueActivityDto,
  type GithubIssueContextDto,
  type GithubIssueStatus,
  type GithubIssueSummaryDto,
  type GithubRepositoryDto,
  type GithubSettingsDto,
} from "@platform/shared";
import type { AuthContext } from "../auth/auth.service";
import { authorize } from "../common/authz";
import { AppError, conflict, notFound, pgCode, validationFailed } from "../common/errors";
import type { Database } from "../common/sql";
import { iso } from "../common/sql-helpers";
import { SlidingWindowLimiter } from "../http/rate-limiter";
import { GitHubBudget } from "./github-budget";
import { normalizeRemoteTimestamp, sanitizeRemoteText } from "./remote-text";

interface RepoRow { id: string; owner: string; repo: string; linked_at: string }
interface LinkRow {
  id: string; organization_id: string; repository_id: string; repository_linked_at: string; issue_number: number; issue_etag: string | null; comments_etag: string | null;
  issue_snapshot: unknown; comments_snapshot: unknown; checked_at: string | null; refresh_after: string; failure_code: Extract<GithubIssueStatus, "not_found_or_private" | "rate_limited" | "unavailable" | "invalid_response"> | null;
  owner: string; repo: string;
}
interface ApiPayload {
  title?: unknown; state?: unknown; body?: unknown; updated_at?: unknown; labels?: unknown; assignee?: unknown; pull_request?: unknown;
}
interface CommentPayload { user?: { login?: unknown } | null; body?: unknown; created_at?: unknown }
interface CachedIssue { title: string; state: string; isPullRequest: boolean; labels: Array<{ name: string; color: string | null }>; assignee: string | null; updatedAt: string; bodyExcerpt: string }
interface FetchResult { status: number; etag: string | null; payload?: unknown; rateLimited: boolean }

const ORG_API_LIMIT_PER_MINUTE = 30;
const PROCESS_LIMIT_PER_HOUR = 50; // Per-process cap on outbound requests; below the unauthenticated 60/hour primary budget.
const MAX_CONCURRENT_REFRESHES = 4;
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 60_000;
const MAX_RESPONSE_BYTES = 180 * 1024;
const BAD_RESPONSE = "invalid_response" as const;

function text(value: unknown, max: number): string {
  return sanitizeRemoteText(value, max);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function parseSnapshot(value: unknown): CachedIssue | null {
  const raw = asObject(parsedJson(value));
  if (!raw || typeof raw.title !== "string" || (raw.state !== "open" && raw.state !== "closed")) return null;
  if (!Array.isArray(raw.labels) || typeof raw.isPullRequest !== "boolean" || typeof raw.bodyExcerpt !== "string") return null;
  const updatedAt = normalizeRemoteTimestamp(raw.updatedAt);
  if (!updatedAt) return null;
  const labels = raw.labels.slice(0, 20).flatMap((item): CachedIssue["labels"] => {
    const label = asObject(item);
    if (!label || typeof label.name !== "string") return [];
    const name = text(label.name, 60);
    if (!name) return [];
    const color = typeof label.color === "string" && /^[0-9a-fA-F]{6}$/.test(label.color) ? label.color.toLowerCase() : null;
    return [{ name, color }];
  });
  return {
    title: text(raw.title, 200) || "Untitled GitHub issue",
    state: raw.state,
    isPullRequest: raw.isPullRequest,
    labels,
    assignee: typeof raw.assignee === "string" ? text(raw.assignee, 39) || null : null,
    updatedAt,
    bodyExcerpt: text(raw.bodyExcerpt, 1_500),
  };
}

function parseActivity(value: unknown): GithubIssueActivityDto[] {
  const parsed = parsedJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 5).flatMap((item): GithubIssueActivityDto[] => {
    const raw = asObject(item);
    if (!raw) return [];
    const createdAt = normalizeRemoteTimestamp(raw.createdAt);
    if (!createdAt) return [];
    return [{ author: text(raw.author, 39) || "unknown", body: text(raw.body, 300), createdAt }];
  });
}

/** Builds a URL only from the fixed GitHub API origin plus schema-validated path segments. */
export function githubApiEndpoint(owner: string, repo: string, issueNumber: number, resource: "issue" | "comments"): string {
  const validOwner = githubOwnerSchema.safeParse(owner);
  const validRepo = githubRepoSchema.safeParse(repo);
  if (!validOwner.success || !validRepo.success || !Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > 2_147_483_647) {
    throw new AppError("VALIDATION_FAILED", "Invalid GitHub repository or issue identifier");
  }
  const suffix = resource === "comments" ? `/comments?per_page=5&sort=created&direction=desc` : "";
  const url = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}${suffix}`, "https://api.github.com");
  if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.port || url.username || url.password) {
    throw new AppError("VALIDATION_FAILED", "Invalid GitHub API endpoint");
  }
  return url.toString();
}

/** Reads a response with a hard bound instead of unbounded response.text()/json() allocation. */
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let content = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GitHub response exceeded size limit");
      }
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(content);
}

function projectIssue(value: unknown): CachedIssue | null {
  const raw = asObject(value) as ApiPayload | null;
  if (!raw || typeof raw.title !== "string" || (raw.state !== "open" && raw.state !== "closed")) return null;
  const updatedAt = normalizeRemoteTimestamp(raw.updated_at);
  if (!updatedAt) return null;
  const labelsRaw = Array.isArray(raw.labels) ? raw.labels : [];
  const labels = labelsRaw.slice(0, 20).flatMap((value) => {
    const label = asObject(value);
    if (!label || typeof label.name !== "string") return [];
    const name = text(label.name, 60);
    if (!name) return [];
    const color = typeof label.color === "string" && /^[0-9a-fA-F]{6}$/.test(label.color) ? label.color.toLowerCase() : null;
    return [{ name, color }];
  });
  const assignee = asObject(raw.assignee);
  return {
    title: text(raw.title, 200) || "Untitled GitHub issue",
    state: raw.state,
    isPullRequest: asObject(raw.pull_request) !== null,
    labels,
    assignee: assignee ? text(assignee.login, 39) || null : null,
    updatedAt,
    bodyExcerpt: text(raw.body, 1_500),
  };
}

function projectComments(value: unknown): GithubIssueActivityDto[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-5).reverse().flatMap((item): GithubIssueActivityDto[] => {
    const raw = asObject(item) as CommentPayload | null;
    if (!raw) return [];
    const createdAt = normalizeRemoteTimestamp(raw.created_at);
    if (!createdAt) return [];
    const user = asObject(raw.user);
    return [{ author: user ? text(user.login, 39) || "unknown" : "unknown", body: text(raw.body, 300), createdAt }];
  });
}

/** Tenant-scoped GitHub issue cache. No GitHub token is accepted, stored, logged, sent to AI, or returned to clients. */
export class GithubIssueService {
  private readonly orgLimiter = new SlidingWindowLimiter(ORG_API_LIMIT_PER_MINUTE, 60_000);
  private readonly processLimiter = new SlidingWindowLimiter(PROCESS_LIMIT_PER_HOUR, 60 * 60_000);
  // Share GitHub's reported REST API quota across refreshes and organizations. The fixed 50/hour process cap remains
  // a second conservative guard when GitHub headers are absent in mocks or intermediaries.
  private readonly githubBudget = new GitHubBudget({ reserve: 5, failureThreshold: 3, breakerMs: 60_000 });
  private activeRefreshes = 0;
  private readonly refreshesInFlight = new Map<string, Promise<LinkRow>>();

  constructor(private readonly db: Database, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => Date = () => new Date()) {}

  async settings(auth: AuthContext): Promise<GithubSettingsDto> {
    const org = authorize(auth, "incident:read");
    const found = await this.db.query<{ enabled: boolean }>("SELECT enabled FROM organization_github_settings WHERE organization_id = $1", [org]);
    return { enabled: found.rows[0]?.enabled ?? false, repositories: await this.repositories(org) };
  }

  async updateSettings(auth: AuthContext, raw: unknown): Promise<GithubSettingsDto> {
    const org = authorize(auth, "integration:manage");
    const parsed = githubSettingsSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    await this.db.query(
      `INSERT INTO organization_github_settings (organization_id, enabled, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (organization_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [org, parsed.data.enabled, auth.userId],
    );
    return { enabled: parsed.data.enabled, repositories: await this.repositories(org) };
  }

  async addRepository(auth: AuthContext, raw: unknown): Promise<GithubRepositoryDto> {
    const org = authorize(auth, "integration:manage");
    const parsed = githubRepositorySchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const settings = await this.db.query<{ enabled: boolean }>("SELECT enabled FROM organization_github_settings WHERE organization_id = $1", [org]);
    if (!settings.rows[0]?.enabled) throw new AppError("FEATURE_DISABLED", "Enable GitHub issue enrichment for this organization first");
    try {
      const inserted = await this.db.query<RepoRow>(
        `INSERT INTO github_repositories (organization_id, owner, repo, linked_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, owner, repo, ${iso("linked_at")} AS linked_at`,
        [org, parsed.data.owner, parsed.data.repo, auth.userId],
      );
      return this.toRepo(inserted.rows[0]!);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505") throw conflict("That repository is already linked to this organization");
      throw error;
    }
  }

  async removeRepository(auth: AuthContext, repositoryId: string): Promise<void> {
    const org = authorize(auth, "integration:manage");
    if (!uuidSchema.safeParse(repositoryId).success) throw notFound("Repository");
    const removed = await this.db.query<{ id: string }>("DELETE FROM github_repositories WHERE organization_id = $1 AND id = $2 RETURNING id", [org, repositoryId]);
    if (!removed.rows.length) throw notFound("Repository");
  }

  async linkIssue(auth: AuthContext, incidentId: string, raw: unknown): Promise<GithubIssueContextDto> {
    const org = authorize(auth, "incident:update");
    if (!uuidSchema.safeParse(incidentId).success) throw notFound("Incident");
    const parsed = linkGithubIssueSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const settings = await this.db.query<{ enabled: boolean }>("SELECT enabled FROM organization_github_settings WHERE organization_id = $1", [org]);
    if (!settings.rows[0]?.enabled) throw new AppError("FEATURE_DISABLED", "GitHub issue enrichment is disabled for this organization");
    const repo = await this.db.query<RepoRow>(
      `SELECT id, owner, repo, ${iso("linked_at")} AS linked_at FROM github_repositories WHERE organization_id = $1 AND id = $2`,
      [org, parsed.data.repositoryId],
    );
    if (!repo.rows[0]) throw notFound("Repository");
    const incident = await this.db.query<{ id: string }>("SELECT id FROM incidents WHERE organization_id = $1 AND id = $2", [org, incidentId]);
    if (!incident.rows.length) throw notFound("Incident");
    try {
      await this.db.query(
        `INSERT INTO github_issue_links (organization_id, incident_id, repository_id, issue_number, linked_by, refresh_after)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (organization_id, incident_id) DO UPDATE SET repository_id = EXCLUDED.repository_id, issue_number = EXCLUDED.issue_number,
           issue_etag = NULL, comments_etag = NULL, issue_snapshot = '{}'::jsonb, comments_snapshot = '[]'::jsonb,
           checked_at = NULL, refresh_after = now(), failure_code = NULL, linked_by = EXCLUDED.linked_by, updated_at = now()`,
        [org, incidentId, repo.rows[0].id, parsed.data.issueNumber, auth.userId],
      );
    } catch (error) {
      // The incident or repository may be deleted after its tenant-scoped preflight read. Treat that ordinary race as
      // not-found rather than exposing a database FK error as a 500.
      if (pgCode(error) === "23503") throw notFound("Incident or GitHub repository");
      throw error;
    }
    return this.context(auth, incidentId);
  }

  async unlinkIssue(auth: AuthContext, incidentId: string): Promise<void> {
    const org = authorize(auth, "incident:update");
    if (!uuidSchema.safeParse(incidentId).success) throw notFound("Incident");
    const removed = await this.db.query<{ id: string }>("DELETE FROM github_issue_links WHERE organization_id = $1 AND incident_id = $2 RETURNING id", [org, incidentId]);
    if (!removed.rows.length) throw notFound("GitHub issue link");
  }

  async context(auth: AuthContext, incidentId: string): Promise<GithubIssueContextDto> {
    const org = authorize(auth, "incident:read");
    if (!uuidSchema.safeParse(incidentId).success) throw notFound("Incident");
    const incident = await this.db.query<{ id: string }>("SELECT id FROM incidents WHERE organization_id = $1 AND id = $2", [org, incidentId]);
    if (!incident.rows.length) throw notFound("Incident");
    const settings = await this.db.query<{ enabled: boolean }>("SELECT enabled FROM organization_github_settings WHERE organization_id = $1", [org]);
    const enabled = settings.rows[0]?.enabled ?? false;
    const found = await this.db.query<LinkRow>(
      `SELECT l.id, l.organization_id, l.repository_id, ${iso("r.linked_at")} AS repository_linked_at, l.issue_number, l.issue_etag, l.comments_etag, l.issue_snapshot, l.comments_snapshot,
              ${iso("l.checked_at")} AS checked_at, ${iso("l.refresh_after")} AS refresh_after, l.failure_code,
              r.owner, r.repo
         FROM github_issue_links l
         JOIN github_repositories r ON r.organization_id = l.organization_id AND r.id = l.repository_id
         JOIN incidents i ON i.organization_id = l.organization_id AND i.id = l.incident_id
        WHERE l.organization_id = $1 AND l.incident_id = $2`,
      [org, incidentId],
    );
    const row = found.rows[0];
    if (!enabled) return { enabled: false, status: "disabled", link: row ? this.linkDto(row) : null, issue: null, checkedAt: row?.checked_at ?? null };
    if (!row) return { enabled: true, status: "unlinked", link: null, issue: null, checkedAt: null };
    const refreshed = Date.parse(row.refresh_after) <= this.now().getTime() ? await this.refreshOnce(org, row) : row;
    const status: GithubIssueStatus = refreshed.failure_code ?? (parseSnapshot(refreshed.issue_snapshot) ? "available" : "unavailable");
    return { enabled: true, status, link: this.linkDto(refreshed), issue: this.issueDto(refreshed), checkedAt: refreshed.checked_at };
  }

  /** Coalesce concurrent page loads for the same incident link into a single pair of GitHub requests. */
  private refreshOnce(org: string, row: LinkRow): Promise<LinkRow> {
    const existing = this.refreshesInFlight.get(row.id);
    if (existing) return existing;
    const pending = this.refresh(org, row).finally(() => {
      if (this.refreshesInFlight.get(row.id) === pending) this.refreshesInFlight.delete(row.id);
    });
    this.refreshesInFlight.set(row.id, pending);
    return pending;
  }

  private async refresh(org: string, row: LinkRow): Promise<LinkRow> {
    if (this.activeRefreshes >= MAX_CONCURRENT_REFRESHES) return this.recordFailure(row, "unavailable");
    this.activeRefreshes += 1;
    try {
      const currentIssue = parseSnapshot(row.issue_snapshot);
      const issueEndpoint = githubApiEndpoint(row.owner, row.repo, row.issue_number, "issue");
      let issueResult = await this.requestGithub(org, issueEndpoint, row.issue_etag);
      if (issueResult.rateLimited) return await this.recordFailure(row, "rate_limited");
      if (issueResult.status === 404) return await this.recordFailure(row, "not_found_or_private");
      if (issueResult.status === 304 && !currentIssue) {
        // A 304 is useful only when a valid representation is cached. Recover from an inconsistent/stale cache by
        // making one unconditional GET rather than returning unavailable forever on every refresh.
        issueResult = await this.requestGithub(org, issueEndpoint, null);
        if (issueResult.rateLimited) return await this.recordFailure(row, "rate_limited");
        if (issueResult.status === 404) return await this.recordFailure(row, "not_found_or_private");
      }
      if (issueResult.status === 304 && currentIssue) {
        const commentsResult = await this.requestGithub(org, githubApiEndpoint(row.owner, row.repo, row.issue_number, "comments"), row.comments_etag);
        if (commentsResult.rateLimited) return await this.recordFailure(row, "rate_limited");
        let comments = parseActivity(row.comments_snapshot);
        let commentsEtag = row.comments_etag;
        if (commentsResult.status === 200) {
          comments = projectComments(commentsResult.payload);
          commentsEtag = commentsResult.etag;
        } else if (commentsResult.status !== 304) {
          // The issue is unchanged, but activity could not be refreshed. Preserve cached comments and expose the partial failure.
          return this.saveSnapshot(row, currentIssue, comments, row.issue_etag, commentsEtag, "unavailable");
        }
        return this.saveSnapshot(row, currentIssue, comments, row.issue_etag, commentsEtag, null);
      }
      if (issueResult.status !== 200) return await this.recordFailure(row, "unavailable");
      const issue = projectIssue(issueResult.payload);
      if (!issue) return await this.recordFailure(row, BAD_RESPONSE);
      const commentsResult = await this.requestGithub(org, githubApiEndpoint(row.owner, row.repo, row.issue_number, "comments"), row.comments_etag);
      let comments = parseActivity(row.comments_snapshot);
      let commentsEtag = row.comments_etag;
      if (commentsResult.status === 200) {
        comments = projectComments(commentsResult.payload);
        commentsEtag = commentsResult.etag;
      } else if (commentsResult.status !== 304 && commentsResult.rateLimited) {
        // The issue itself is useful. Keep it and mark the partial refresh as rate-limited.
        const saved = await this.saveSnapshot(row, issue, comments, issueResult.etag, commentsEtag, "rate_limited");
        return saved;
      } else if (commentsResult.status !== 304 && commentsResult.status !== 200) {
        // A redirect is never followed; other failed comment requests degrade the status without discarding the issue.
        return this.saveSnapshot(row, issue, comments, issueResult.etag, commentsEtag, "unavailable");
      }
      return this.saveSnapshot(row, issue, comments, issueResult.etag, commentsEtag, null);
    } catch {
      return await this.recordFailure(row, "unavailable");
    } finally {
      this.activeRefreshes -= 1;
    }
  }

  private async requestGithub(org: string, endpoint: string, etag: string | null): Promise<FetchResult> {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.port || url.username || url.password) throw new Error("Refusing non-GitHub API URL");
    // Count every outbound API request against per-org, process-wide and GitHub-reported quotas. One refresh can issue two GETs.
    const nowMs = this.now().getTime();
    const budgetGate = this.githubBudget.check(nowMs);
    if (!budgetGate.ok) return { status: 429, etag: null, rateLimited: true };
    const orgGate = this.orgLimiter.consume(org);
    if (!orgGate.allowed) return { status: 429, etag: null, rateLimited: true };
    const processGate = this.processLimiter.consume("github-api");
    if (!processGate.allowed) return { status: 429, etag: null, rateLimited: true };
    const acquireGate = this.githubBudget.tryAcquire(nowMs);
    if (!acquireGate.ok) return { status: 429, etag: null, rateLimited: true };
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "incident-intelligence-platform" };
    if (etag && etag.length <= 512 && !/[\r\n]/.test(etag)) headers["If-None-Match"] = etag;
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      this.githubBudget.record(this.now().getTime(), 0, { get: () => null });
      throw error;
    }
    this.githubBudget.record(this.now().getTime(), response.status, response.headers);
    const nextEtagRaw = response.headers.get("etag");
    const nextEtag = nextEtagRaw && nextEtagRaw.length <= 512 && !/[\r\n]/.test(nextEtagRaw) ? nextEtagRaw : null;
    const rateLimited = response.status === 429 || response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
    if (response.status === 304 || !response.ok) return { status: response.status, etag: nextEtag, rateLimited };
    let payload: unknown;
    try { payload = await boundedJson(response); } catch { return { status: 502, etag: nextEtag, rateLimited: false }; }
    return { status: response.status, etag: nextEtag, payload, rateLimited };
  }

  private async saveSnapshot(row: LinkRow, issue: CachedIssue, comments: GithubIssueActivityDto[], issueEtag: string | null, commentsEtag: string | null, failure: Extract<GithubIssueStatus, "not_found_or_private" | "rate_limited" | "unavailable" | "invalid_response"> | null): Promise<LinkRow> {
    const nowIso = this.now().toISOString();
    const result = await this.db.query<LinkRow>(
      `UPDATE github_issue_links SET issue_etag = $3, comments_etag = $4, issue_snapshot = $5::jsonb, comments_snapshot = $6::jsonb,
              checked_at = $7::timestamptz, refresh_after = $8::timestamptz, failure_code = $9, updated_at = now()
        WHERE id = $1 AND organization_id = $2
        RETURNING id, organization_id, repository_id, $10::text AS repository_linked_at, issue_number, issue_etag, comments_etag, issue_snapshot, comments_snapshot,
                  ${iso("checked_at")} AS checked_at, ${iso("refresh_after")} AS refresh_after, failure_code,
                  $11::text AS owner, $12::text AS repo`,
      [row.id, row.organization_id, issueEtag, commentsEtag, JSON.stringify(issue), JSON.stringify(comments), nowIso,
        new Date(this.now().getTime() + (failure ? FAILURE_TTL_MS : CACHE_TTL_MS)).toISOString(), failure, row.repository_linked_at, row.owner, row.repo],
    );
    return result.rows[0] ?? { ...row, issue_snapshot: issue, comments_snapshot: comments, checked_at: nowIso, refresh_after: new Date(this.now().getTime() + CACHE_TTL_MS).toISOString(), failure_code: failure };
  }

  private async recordFailure(row: LinkRow, failure: Extract<GithubIssueStatus, "not_found_or_private" | "rate_limited" | "unavailable" | "invalid_response">): Promise<LinkRow> {
    const nowIso = this.now().toISOString();
    const until = new Date(this.now().getTime() + FAILURE_TTL_MS).toISOString();
    const unavailableIssue = failure === "not_found_or_private";
    const updated = await this.db.query<LinkRow>(
      `UPDATE github_issue_links SET
              issue_etag = CASE WHEN $5::text = 'not_found_or_private' THEN NULL ELSE issue_etag END,
              comments_etag = CASE WHEN $5::text = 'not_found_or_private' THEN NULL ELSE comments_etag END,
              issue_snapshot = CASE WHEN $5::text = 'not_found_or_private' THEN '{}'::jsonb ELSE issue_snapshot END,
              comments_snapshot = CASE WHEN $5::text = 'not_found_or_private' THEN '[]'::jsonb ELSE comments_snapshot END,
              checked_at = $3::timestamptz, refresh_after = $4::timestamptz, failure_code = $5, updated_at = now()
        WHERE id = $1 AND organization_id = $2
        RETURNING id, organization_id, repository_id, $6::text AS repository_linked_at, issue_number, issue_etag, comments_etag, issue_snapshot, comments_snapshot,
                  ${iso("checked_at")} AS checked_at, ${iso("refresh_after")} AS refresh_after, failure_code,
                  $7::text AS owner, $8::text AS repo`,
      [row.id, row.organization_id, nowIso, until, failure, row.repository_linked_at, row.owner, row.repo],
    );
    return updated.rows[0] ?? {
      ...row,
      issue_etag: unavailableIssue ? null : row.issue_etag,
      comments_etag: unavailableIssue ? null : row.comments_etag,
      issue_snapshot: unavailableIssue ? {} : row.issue_snapshot,
      comments_snapshot: unavailableIssue ? [] : row.comments_snapshot,
      checked_at: nowIso,
      refresh_after: until,
      failure_code: failure,
    };
  }

  private issueDto(row: LinkRow): GithubIssueSummaryDto | null {
    // A formerly public issue may become private; do not reveal its stale body after a 404.
    if (row.failure_code === "not_found_or_private") return null;
    const issue = parseSnapshot(row.issue_snapshot);
    if (!issue) return null;
    return { ...issue, recentActivity: parseActivity(row.comments_snapshot) };
  }

  private linkDto(row: LinkRow) {
    return {
      id: row.id,
      repository: { id: row.repository_id, owner: row.owner, repo: row.repo, linkedAt: row.repository_linked_at },
      issueNumber: Number(row.issue_number),
      url: `https://github.com/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}/issues/${Number(row.issue_number)}`,
    };
  }

  private async repositories(org: string): Promise<GithubRepositoryDto[]> {
    const rows = await this.db.query<RepoRow>(`SELECT id, owner, repo, ${iso("linked_at")} AS linked_at FROM github_repositories WHERE organization_id = $1 ORDER BY lower(owner), lower(repo)`, [org]);
    return rows.rows.map((r) => this.toRepo(r));
  }

  private toRepo(row: RepoRow): GithubRepositoryDto { return { id: row.id, owner: row.owner, repo: row.repo, linkedAt: row.linked_at }; }
}
