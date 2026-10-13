/**
 * A framework-neutral view of an HTTP exchange. The NestJS controllers only translate Express objects into these
 * shapes; every rule (cookie, Origin check, authentication, error mapping) lives in ApiHandlers and is tested
 * directly against a real database.
 */
export interface HttpRequest {
  method: string;
  /** Client address as resolved by Express (honours TRUST_PROXY_HOPS only). */
  ip: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: unknown;
  query: Readonly<Record<string, unknown>>;
  params: Readonly<Record<string, string>>;
}

export interface CookieToSet {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

export interface HttpResult {
  status: number;
  body?: unknown;
  setCookie?: CookieToSet;
  clearCookie?: { name: string; options: Record<string, unknown> };
  headers?: Record<string, string>;
}

export interface ErrorResponse {
  status: number;
  body: { error: { code: string; message: string; details?: unknown } };
  headers?: Record<string, string>;
}
