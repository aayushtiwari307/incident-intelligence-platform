import {
  registerSchema,
  registerWithInviteSchema,
  loginSchema,
  type MeDto,
  type MembershipDto,
  type OrgRole,
  type RegisterInput,
  type RegisterWithInviteInput,
  type LoginInput,
} from "@platform/shared";
import { randomBytes } from "node:crypto";
import { PG, conflict, forbidden, notFound, pgCode, rateLimited, unauthenticated, validationFailed } from "../common/errors";
import type { Database, SqlClient } from "../common/sql";
import type { SlidingWindowLimiter } from "../http/rate-limiter";
import type { PasswordHasher } from "./password";
import { generateToken, hashToken } from "./tokens";

/** Who is making the request, resolved from the session cookie on every request. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  /** Active organization of the session; null until the user belongs to / selects one. */
  organizationId: string | null;
  /** Role in the active organization, read from the LIVE membership row (a demotion applies immediately). */
  role: OrgRole | null;
}

export interface AuthServiceOptions {
  sessionTtlSeconds: number;
  /** Limits login attempts per client IP (all accounts). */
  loginIpLimiter: SlidingWindowLimiter;
  /** Limits login attempts per (account, IP) pair, so an attacker cannot lock a victim out from other addresses. */
  loginAccountLimiter: SlidingWindowLimiter;
  registerIpLimiter: SlidingWindowLimiter;
}

export interface RequestMeta {
  ip: string;
}

export interface Authenticated {
  /** The raw session token: goes into the cookie, never stored or logged. */
  token: string;
  me: MeDto;
}

const GENERIC_LOGIN_FAILURE = "Invalid email or password";

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return `${base || "org"}-${randomBytes(3).toString("hex")}`;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly hasher: PasswordHasher,
    private readonly options: AuthServiceOptions,
  ) {}

  async register(raw: unknown, meta: RequestMeta): Promise<Authenticated> {
    const parsed = registerSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const input: RegisterInput = parsed.data;

    const gate = this.options.registerIpLimiter.consume(meta.ip);
    if (!gate.allowed) throw rateLimited(gate.retryAfterSeconds);

    const passwordHash = await this.hasher.hash(input.password);
    const token = generateToken();

    try {
      const userId = await this.db.tx(async (tx) => {
        const user = await tx.query<{ id: string }>(
          "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id",
          [input.email, passwordHash, input.displayName],
        );
        const id = (user.rows[0] as { id: string }).id;
        const org = await tx.query<{ id: string }>("INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING id", [
          slugify(input.organizationName),
          input.organizationName,
        ]);
        const orgId = (org.rows[0] as { id: string }).id;
        // The organization and its first owner are created together; the database refuses an ownerless organization at COMMIT.
        await tx.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, id]);
        await this.insertSession(tx, id, orgId, token);
        return id;
      });
      return { token, me: await this.loadMe(this.db, userId, await this.sessionIdOf(token)) };
    } catch (error) {
      if (pgCode(error) === PG.uniqueViolation && String((error as { constraint?: string }).constraint ?? "").includes("users_email")) {
        // Telling the caller the email is taken reveals that it is registered. Without email verification there is no
        // way to avoid that entirely; registration is rate limited per IP to make bulk harvesting expensive.
        throw conflict("An account with this email already exists");
      }
      throw error;
    }
  }

  /**
   * Creates a first-time invited user directly in the invited organization. The invite, membership and session
   * are committed together; no personal/throwaway organization is created. Existing accounts must sign in and
   * redeem the invite through the authenticated accept-invite endpoint.
   */
  async registerWithInvite(raw: unknown, meta: RequestMeta): Promise<Authenticated> {
    const parsed = registerWithInviteSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const input: RegisterWithInviteInput = parsed.data;

    const gate = this.options.registerIpLimiter.consume(meta.ip);
    if (!gate.allowed) throw rateLimited(gate.retryAfterSeconds);

    const passwordHash = await this.hasher.hash(input.password);
    const sessionToken = generateToken();

    try {
      const created = await this.db.tx(async (tx) => {
        const found = await tx.query<{
          id: string;
          organization_id: string;
          email: string;
          role: OrgRole;
        }>(
          `SELECT id, organization_id, email, role FROM organization_invites
            WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
            FOR UPDATE`,
          [hashToken(input.inviteToken)],
        );
        const invite = found.rows[0];
        // Match the existing redemption behavior: invalid, expired, revoked, used, and wrong-email tokens all look alike.
        if (!invite || invite.email !== input.email) throw notFound("Invitation");

        const user = await tx.query<{ id: string }>(
          "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id",
          [input.email, passwordHash, input.displayName],
        );
        const userId = (user.rows[0] as { id: string }).id;
        await tx.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)", [
          invite.organization_id,
          userId,
          invite.role,
        ]);
        await tx.query("UPDATE organization_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1", [invite.id, userId]);
        const sessionId = await this.insertSession(tx, userId, invite.organization_id, sessionToken);
        return { userId, sessionId };
      });
      return { token: sessionToken, me: await this.loadMe(this.db, created.userId, created.sessionId) };
    } catch (error) {
      if (pgCode(error) === PG.uniqueViolation && String((error as { constraint?: string }).constraint ?? "").includes("users_email")) {
        throw conflict("An account with this email already exists. Sign in and accept the invitation instead.");
      }
      throw error;
    }
  }

  async login(raw: unknown, meta: RequestMeta): Promise<Authenticated> {
    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const input: LoginInput = parsed.data;

    // Throttle BEFORE doing any expensive hashing.
    const ipGate = this.options.loginIpLimiter.consume(meta.ip);
    if (!ipGate.allowed) throw rateLimited(ipGate.retryAfterSeconds);
    const accountKey = `${input.email}|${meta.ip}`;
    const accountGate = this.options.loginAccountLimiter.consume(accountKey);
    if (!accountGate.allowed) throw rateLimited(accountGate.retryAfterSeconds);

    const found = await this.db.query<{ id: string; password_hash: string; disabled: string | null }>(
      "SELECT id, password_hash, disabled_at::text AS disabled FROM users WHERE email = $1",
      [input.email],
    );
    const user = found.rows[0];

    // Same work and same message whether the email is unknown, the account is disabled, or the password is wrong.
    const valid = user ? await this.hasher.verify(input.password, user.password_hash) : await this.hasher.verifyDummy(input.password);
    if (!user || user.disabled !== null || !valid) throw unauthenticated(GENERIC_LOGIN_FAILURE);

    this.options.loginAccountLimiter.reset(accountKey);

    if (this.hasher.needsRehash(user.password_hash)) {
      // Upgrade old hashes transparently; failure to do so must not block the login.
      void this.hasher
        .hash(input.password)
        .then((hash) => this.db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, user.id]))
        .catch(() => undefined);
    }

    const token = generateToken();
    const sessionId = await this.db.tx(async (tx) => {
      const first = await tx.query<{ organization_id: string }>(
        "SELECT organization_id FROM memberships WHERE user_id = $1 ORDER BY created_at, organization_id LIMIT 1",
        [user.id],
      );
      return this.insertSession(tx, user.id, first.rows[0]?.organization_id ?? null, token);
    });
    return { token, me: await this.loadMe(this.db, user.id, sessionId) };
  }

  /** Resolves a session token to an AuthContext, or null when it is unknown, expired, revoked, or the user is disabled. */
  async authenticate(token: string | undefined): Promise<AuthContext | null> {
    if (!token || token.length > 200) return null;
    const result = await this.db.query<{
      session_id: string;
      user_id: string;
      email: string;
      display_name: string;
      organization_id: string | null;
      role: OrgRole | null;
    }>(
      `SELECT s.id AS session_id, s.user_id, u.email, u.display_name, s.organization_id, m.role
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL
         LEFT JOIN memberships m ON m.organization_id = s.organization_id AND m.user_id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      organizationId: row.organization_id,
      role: row.role,
    };
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.db.query("UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [auth.sessionId]);
  }

  me(auth: AuthContext): Promise<MeDto> {
    return this.loadMe(this.db, auth.userId, auth.sessionId);
  }

  /** Chooses the active organization. The target must be one of the caller's own memberships (enforced by a composite foreign key too). */
  async switchOrganization(auth: AuthContext, organizationId: string): Promise<MeDto> {
    const member = await this.db.query("SELECT 1 FROM memberships WHERE user_id = $1 AND organization_id = $2", [auth.userId, organizationId]);
    if (member.rows.length === 0) throw notFound("Organization");
    await this.db.query("UPDATE auth_sessions SET organization_id = $1 WHERE id = $2", [organizationId, auth.sessionId]);
    return this.loadMe(this.db, auth.userId, auth.sessionId);
  }

  private async insertSession(tx: SqlClient, userId: string, organizationId: string | null, token: string): Promise<string> {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, organization_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4::int)) RETURNING id`,
      [userId, organizationId, hashToken(token), this.options.sessionTtlSeconds],
    );
    return (result.rows[0] as { id: string }).id;
  }

  private async sessionIdOf(token: string): Promise<string> {
    const r = await this.db.query<{ id: string }>("SELECT id FROM auth_sessions WHERE token_hash = $1", [hashToken(token)]);
    return (r.rows[0] as { id: string }).id;
  }

  private async loadMe(db: SqlClient, userId: string, sessionId: string): Promise<MeDto> {
    const user = await db.query<{ id: string; email: string; display_name: string; organization_id: string | null }>(
      `SELECT u.id, u.email, u.display_name, s.organization_id
         FROM users u JOIN auth_sessions s ON s.user_id = u.id WHERE u.id = $1 AND s.id = $2`,
      [userId, sessionId],
    );
    const row = user.rows[0];
    if (!row) throw forbidden("Session is no longer valid");
    const memberships = await db.query<{ organization_id: string; name: string; role: OrgRole }>(
      `SELECT m.organization_id, o.name, m.role FROM memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY m.created_at, m.organization_id`,
      [userId],
    );
    const list: MembershipDto[] = memberships.rows.map((m) => ({ organizationId: m.organization_id, organizationName: m.name, role: m.role }));
    const active = list.find((m) => m.organizationId === row.organization_id);
    return {
      user: { id: row.id, email: row.email, displayName: row.display_name },
      memberships: list,
      activeOrganizationId: active?.organizationId ?? null,
      role: active?.role ?? null,
    };
  }
}

