import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AuthService, type AuthContext } from "../auth/auth.service";
import { unauthenticated, AppError } from "../common/errors";
import { APP_CONFIG } from "../config/config.module";
import type { AppConfig } from "../config/env";
import { parseCookies, sessionCookieName } from "./cookies";
import { isOriginAllowed } from "./csrf";

/** Shared session adapter for feature controllers. Tenant and role always come from the live session membership. */
@Injectable()
export class SessionContext {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async authenticate(req: Request): Promise<AuthContext> {
    const rawOrigin = req.headers.origin;
    // Reject malformed repeated Origin headers instead of treating them as an absent origin.
    if (Array.isArray(rawOrigin)) throw new AppError("ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
    if (!isOriginAllowed({
      method: req.method,
      origin: rawOrigin,
      allowedOrigins: this.config.http.corsOrigins,
    })) throw new AppError("ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
    const token = parseCookies(req.headers.cookie)[sessionCookieName(this.config.nodeEnv === "production")];
    const context = await this.auth.authenticate(token);
    if (!context) throw unauthenticated();
    return context;
  }
}
