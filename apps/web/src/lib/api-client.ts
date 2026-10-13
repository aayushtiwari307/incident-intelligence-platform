import type {
  IncidentDto,
  IncidentEventDto,
  IncidentListDto,
  AnalysisStateDto,
  IncidentSeverity,
  IncidentStatus,
  MeDto,
  MemberDto,
  OrgRole,
} from "@platform/shared";

/** An error response from the API (or a network failure, status 0). `code` is the stable machine-readable value. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level problems from a 400, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.code === "VALIDATION_FAILED" && Array.isArray(this.details)) {
      for (const d of this.details as Array<{ path?: unknown; message?: unknown }>) {
        const path = typeof d.path === "string" ? d.path : "";
        if (!(path in out) && typeof d.message === "string") out[path] = d.message;
      }
    }
    return out;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface InviteSummary {
  id: string;
  email: string;
  role: "viewer" | "responder" | "admin";
  createdAt: string;
  expiresAt: string;
}
export interface CreatedInvite extends InviteSummary {
  /** Shown once to the inviting admin; the server keeps only a hash. */
  token: string;
}

export interface IncidentFilters {
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  assignee?: "me" | "unassigned" | string;
  cursor?: string;
  limit?: number;
}

export interface ApiClient {
  register(input: { email: string; password: string; displayName: string; organizationName: string }): Promise<MeDto>;
  registerWithInvite(input: { email: string; password: string; displayName: string; inviteToken: string }): Promise<MeDto>;
  login(input: { email: string; password: string }): Promise<MeDto>;
  logout(): Promise<void>;
  me(): Promise<MeDto>;
  switchOrganization(organizationId: string): Promise<MeDto>;
  listMembers(): Promise<MemberDto[]>;
  changeRole(userId: string, role: OrgRole): Promise<MemberDto>;
  removeMember(userId: string): Promise<void>;
  listInvites(): Promise<InviteSummary[]>;
  createInvite(input: { email: string; role: InviteSummary["role"] }): Promise<CreatedInvite>;
  revokeInvite(id: string): Promise<void>;
  acceptInvite(token: string): Promise<MeDto>;
  listIncidents(filters?: IncidentFilters): Promise<IncidentListDto>;
  getIncident(id: string): Promise<IncidentDto>;
  createIncident(input: { title: string; description: string; severity: IncidentSeverity; assigneeId?: string | null }): Promise<IncidentDto>;
  updateIncident(
    id: string,
    input: { expectedVersion: number; title?: string; description?: string; severity?: IncidentSeverity; assigneeId?: string | null },
  ): Promise<IncidentDto>;
  transitionIncident(id: string, input: { to: IncidentStatus; expectedVersion: number; note?: string }): Promise<IncidentDto>;
  comment(id: string, body: string): Promise<IncidentEventDto>;
  timeline(id: string): Promise<IncidentEventDto[]>;
  analysisState(id: string): Promise<AnalysisStateDto>;
  requestAnalysis(id: string): Promise<AnalysisStateDto>;
}

/**
 * Typed client for the API. The session lives in an HttpOnly cookie the browser attaches (`credentials: "include"`),
 * so no token is ever handled by script. No organization id is ever sent: the server derives it from the session.
 */
export function createApiClient(baseUrl: string, fetchImpl: FetchLike = (i, init) => fetch(i, init)): ApiClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") params.set(k, String(v));
    const url = `${base}${path}${params.size > 0 ? `?${params}` : ""}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        credentials: "include",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "NETWORK", "Could not reach the server. Check your connection and try again.");
    }
    if (response.status === 204) return undefined as T;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new ApiError(response.status, error?.code ?? "UNKNOWN", error?.message ?? `Request failed (${response.status})`, error?.details);
    }
    return payload as T;
  }

  const enc = encodeURIComponent;
  return {
    register: (input) => request("POST", "/api/auth/register", input),
    registerWithInvite: (input) => request("POST", "/api/auth/register-with-invite", input),
    login: (input) => request("POST", "/api/auth/login", input),
    logout: () => request("POST", "/api/auth/logout", {}),
    me: () => request("GET", "/api/auth/me"),
    switchOrganization: (organizationId) => request("POST", "/api/auth/switch-organization", { organizationId }),
    listMembers: async () => (await request<{ items: MemberDto[] }>("GET", "/api/organization/members")).items,
    changeRole: (userId, role) => request("PATCH", `/api/organization/members/${enc(userId)}`, { role }),
    removeMember: (userId) => request("DELETE", `/api/organization/members/${enc(userId)}`),
    listInvites: async () => (await request<{ items: InviteSummary[] }>("GET", "/api/organization/invites")).items,
    createInvite: (input) => request("POST", "/api/organization/invites", input),
    revokeInvite: (id) => request("DELETE", `/api/organization/invites/${enc(id)}`),
    acceptInvite: (token) => request("POST", "/api/organization/invites/accept", { token }),
    listIncidents: (f = {}) =>
      request("GET", "/api/incidents", undefined, { status: f.status, severity: f.severity, assignee: f.assignee, cursor: f.cursor, limit: f.limit }),
    getIncident: (id) => request("GET", `/api/incidents/${enc(id)}`),
    createIncident: (input) => request("POST", "/api/incidents", input),
    updateIncident: (id, input) => request("PATCH", `/api/incidents/${enc(id)}`, input),
    transitionIncident: (id, input) => request("POST", `/api/incidents/${enc(id)}/transitions`, input),
    comment: (id, body) => request("POST", `/api/incidents/${enc(id)}/comments`, { body }),
    analysisState: (id) => request("GET", `/api/incidents/${enc(id)}/analysis`),
    requestAnalysis: (id) => request("POST", `/api/incidents/${enc(id)}/analysis`),
    timeline: async (id) => (await request<{ items: IncidentEventDto[] }>("GET", `/api/incidents/${enc(id)}/timeline`)).items,
  };
}
