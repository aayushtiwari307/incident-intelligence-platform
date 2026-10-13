import type { MeDto } from "@platform/shared";
import { AuthService, type AuthContext } from "../auth/auth.service";
import { AppError, unauthenticated } from "../common/errors";
import { AnalysisService } from "../analysis/analysis.service";
import { IncidentService } from "../incidents/incident.service";
import { OrganizationService } from "../organizations/organization.service";
import { clearedSessionCookie, parseCookies, sessionCookie, sessionCookieName } from "./cookies";
import { isOriginAllowed } from "./csrf";
import type { HttpRequest, HttpResult } from "./http-types";

export interface ApiHandlersOptions {
  allowedOrigins: readonly string[];
  secureCookies: boolean;
  sessionTtlSeconds: number;
  /**
   * Called after a change that can end a live connection's right to receive pushes (logout, organization switch or
   * invitation redemption, member removal). Optional: absent in most tests.
   */
  onAccessChanged?: () => void;
}

const NO_STORE = { "Cache-Control": "no-store" };
const ok = (body: unknown, status = 200): HttpResult => ({ status, body, headers: NO_STORE });

const header = (req: HttpRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * All HTTP behaviour of the API, independent of the web framework.
 *
 * Every state-changing request first passes the Origin check (CSRF), every protected request is authenticated from
 * the session cookie, and the organization is ALWAYS taken from the authenticated session. No handler reads an
 * organization id from the body, query or path.
 */
export class ApiHandlers {
  constructor(
    private readonly auth: AuthService,
    private readonly organizations: OrganizationService,
    private readonly incidents: IncidentService,
    private readonly analysis: AnalysisService,
    private readonly options: ApiHandlersOptions,
  ) {}

  private checkOrigin(req: HttpRequest): void {
    if (!isOriginAllowed({ method: req.method, origin: header(req, "origin"), allowedOrigins: this.options.allowedOrigins })) {
      throw new AppError("ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
    }
  }

  private token(req: HttpRequest): string | undefined {
    return parseCookies(header(req, "cookie"))[sessionCookieName(this.options.secureCookies)];
  }

  private accessChanged(): void {
    try {
      this.options.onAccessChanged?.();
    } catch {
      // A notification hook must never turn a successful request into a failure.
    }
  }

  private async authenticate(req: HttpRequest): Promise<AuthContext> {
    this.checkOrigin(req);
    const context = await this.auth.authenticate(this.token(req));
    if (!context) throw unauthenticated();
    return context;
  }

  private withSession(token: string, me: MeDto, status = 200): HttpResult {
    return {
      status,
      body: me,
      headers: NO_STORE,
      setCookie: sessionCookie(token, { secure: this.options.secureCookies, maxAgeSeconds: this.options.sessionTtlSeconds }),
    };
  }

  // ---- auth ---------------------------------------------------------------------------------------------------

  async register(req: HttpRequest): Promise<HttpResult> {
    this.checkOrigin(req);
    const result = await this.auth.register(req.body, { ip: req.ip });
    return this.withSession(result.token, result.me, 201);
  }

  async registerWithInvite(req: HttpRequest): Promise<HttpResult> {
    this.checkOrigin(req);
    const result = await this.auth.registerWithInvite(req.body, { ip: req.ip });
    return this.withSession(result.token, result.me, 201);
  }

  async login(req: HttpRequest): Promise<HttpResult> {
    this.checkOrigin(req);
    const result = await this.auth.login(req.body, { ip: req.ip });
    return this.withSession(result.token, result.me);
  }

  /** Idempotent: always clears the cookie, revokes the session if there is one. */
  async logout(req: HttpRequest): Promise<HttpResult> {
    this.checkOrigin(req);
    const context = await this.auth.authenticate(this.token(req));
    if (context) await this.auth.logout(context);
    this.accessChanged();
    return { status: 204, headers: NO_STORE, clearCookie: clearedSessionCookie(this.options.secureCookies) };
  }

  async me(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.auth.me(await this.authenticate(req)));
  }

  async switchOrganization(req: HttpRequest): Promise<HttpResult> {
    const context = await this.authenticate(req);
    const organizationId = (req.body as { organizationId?: unknown } | null)?.organizationId;
    if (typeof organizationId !== "string") throw new AppError("VALIDATION_FAILED", "organizationId is required");
    const me = await this.auth.switchOrganization(context, organizationId);
    this.accessChanged();
    return ok(me);
  }

  // ---- organization -------------------------------------------------------------------------------------------

  async listMembers(req: HttpRequest): Promise<HttpResult> {
    return ok({ items: await this.organizations.listMembers(await this.authenticate(req)) });
  }

  async createInvite(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.organizations.createInvite(await this.authenticate(req), req.body), 201);
  }

  async listInvites(req: HttpRequest): Promise<HttpResult> {
    return ok({ items: await this.organizations.listInvites(await this.authenticate(req)) });
  }

  async revokeInvite(req: HttpRequest): Promise<HttpResult> {
    await this.organizations.revokeInvite(await this.authenticate(req), req.params.id ?? "");
    return { status: 204, headers: NO_STORE };
  }

  async acceptInvite(req: HttpRequest): Promise<HttpResult> {
    const context = await this.authenticate(req);
    await this.organizations.acceptInvite(context, req.body);
    this.accessChanged();
    return ok(await this.auth.me(context));
  }

  async changeRole(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.organizations.changeRole(await this.authenticate(req), req.params.userId ?? "", req.body));
  }

  async removeMember(req: HttpRequest): Promise<HttpResult> {
    await this.organizations.removeMember(await this.authenticate(req), req.params.userId ?? "");
    this.accessChanged();
    return { status: 204, headers: NO_STORE };
  }

  // ---- incidents ----------------------------------------------------------------------------------------------

  async createIncident(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.incidents.create(await this.authenticate(req), req.body), 201);
  }

  async listIncidents(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.incidents.list(await this.authenticate(req), req.query));
  }

  async getIncident(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.incidents.get(await this.authenticate(req), req.params.id ?? ""));
  }

  async updateIncident(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.incidents.update(await this.authenticate(req), req.params.id ?? "", req.body));
  }

  async transitionIncident(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.incidents.transition(await this.authenticate(req), req.params.id ?? "", req.body));
  }

  async commentOnIncident(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.incidents.comment(await this.authenticate(req), req.params.id ?? "", req.body), 201);
  }

  async incidentTimeline(req: HttpRequest): Promise<HttpResult> {
    return ok({ items: await this.incidents.timeline(await this.authenticate(req), req.params.id ?? "", req.query) });
  }

  // ---- AI analysis ---------------------------------------------------------------------------------------------

  async analysisState(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.analysis.state(await this.authenticate(req), req.params.id ?? ""));
  }

  /** 202: the work is queued, not done. The client polls `analysisState`. */
  async requestAnalysis(req: HttpRequest): Promise<HttpResult> {
    return ok(await this.analysis.request(await this.authenticate(req), req.params.id ?? ""), 202);
  }
}
