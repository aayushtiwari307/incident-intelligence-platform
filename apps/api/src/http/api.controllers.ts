import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Post, Put, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { AlertWebhookHandlers } from "../alerts/webhook-handlers";
import { ApiHandlers } from "./api-handlers";
import { readJsonBody } from "./webhook-body";
import type { HttpRequest, HttpResult } from "./http-types";

export function toHttpRequest(req: Request, body: unknown): HttpRequest {
  return {
    method: req.method,
    ip: req.ip ?? "unknown",
    headers: req.headers,
    body,
    query: req.query as Record<string, unknown>,
    params: req.params as Record<string, string>,
  };
}

/** Writes an HttpResult to the Express response. The only place Express response methods are used for API routes. */
export function send(res: Response, result: HttpResult): unknown {
  res.status(result.status);
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  if (result.setCookie) res.cookie(result.setCookie.name, result.setCookie.value, result.setCookie.options);
  if (result.clearCookie) res.clearCookie(result.clearCookie.name, result.clearCookie.options);
  return result.body === undefined ? res.end() : res.json(result.body);
}

@Controller("api/auth")
export class AuthController {
  constructor(@Inject(ApiHandlers) private readonly h: ApiHandlers) {}

  @Post("register")
  async register(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.register(toHttpRequest(req, body)));
  }

  @Post("register-with-invite")
  async registerWithInvite(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.registerWithInvite(toHttpRequest(req, body)));
  }

  @Post("login")
  @HttpCode(200)
  async login(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.login(toHttpRequest(req, body)));
  }

  @Post("logout")
  async logout(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.logout(toHttpRequest(req, body)));
  }

  @Get("me")
  async me(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.me(toHttpRequest(req, undefined)));
  }

  @Post("switch-organization")
  @HttpCode(200)
  async switchOrganization(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.switchOrganization(toHttpRequest(req, body)));
  }
}

@Controller("api/organization")
export class OrganizationController {
  constructor(@Inject(ApiHandlers) private readonly h: ApiHandlers) {}

  @Get("members")
  async members(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.listMembers(toHttpRequest(req, undefined)));
  }

  @Patch("members/:userId")
  async changeRole(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.changeRole(toHttpRequest(req, body)));
  }

  @Delete("members/:userId")
  async removeMember(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.removeMember(toHttpRequest(req, undefined)));
  }

  @Get("invites")
  async invites(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.listInvites(toHttpRequest(req, undefined)));
  }

  @Post("invites")
  async createInvite(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.createInvite(toHttpRequest(req, body)));
  }

  @Post("invites/accept")
  @HttpCode(200)
  async acceptInvite(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.acceptInvite(toHttpRequest(req, body)));
  }

  @Delete("invites/:id")
  async revokeInvite(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.revokeInvite(toHttpRequest(req, undefined)));
  }
}

@Controller("api/incidents")
export class IncidentController {
  constructor(@Inject(ApiHandlers) private readonly h: ApiHandlers) {}

  @Post()
  async create(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.createIncident(toHttpRequest(req, body)));
  }

  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.listIncidents(toHttpRequest(req, undefined)));
  }

  @Get(":id")
  async get(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.getIncident(toHttpRequest(req, undefined)));
  }

  @Get(":id/resolution")
  async getResolution(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.getIncidentResolution(toHttpRequest(req, undefined)));
  }

  @Get(":id/similar")
  async similar(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.similarIncidents(toHttpRequest(req, undefined)));
  }

  @Patch(":id")
  async update(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.updateIncident(toHttpRequest(req, body)));
  }

  @Post(":id/resolution")
  async createResolution(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.createIncidentResolution(toHttpRequest(req, body)));
  }

  @Put(":id/resolution")
  async updateResolution(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.updateIncidentResolution(toHttpRequest(req, body)));
  }

  @Post(":id/transitions")
  @HttpCode(200)
  async transition(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.transitionIncident(toHttpRequest(req, body)));
  }

  @Post(":id/comments")
  async comment(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.commentOnIncident(toHttpRequest(req, body)));
  }

  @Get(":id/timeline")
  async timeline(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.incidentTimeline(toHttpRequest(req, undefined)));
  }

  @Get(":id/analysis")
  async analysisState(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.analysisState(toHttpRequest(req, undefined)));
  }

  @Post(":id/analysis")
  async requestAnalysis(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.requestAnalysis(toHttpRequest(req, undefined)));
  }

  @Get(":id/ai-suggestions")
  async aiSuggestionState(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.aiSuggestionState(toHttpRequest(req, undefined)));
  }

  @Post(":id/ai-suggestions")
  async requestAiSuggestion(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.requestAiSuggestion(toHttpRequest(req, undefined)));
  }

  @Post(":id/ai-suggestions/:suggestionId/apply")
  @HttpCode(200)
  async applyAiSuggestion(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.applyAiSuggestion(toHttpRequest(req, body)));
  }

  @Post(":id/ai-suggestions/:suggestionId/dismiss")
  @HttpCode(200)
  async dismissAiSuggestion(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.dismissAiSuggestion(toHttpRequest(req, undefined)));
  }
}

@Controller("api/organization/ai-settings")
export class AiSettingsController {
  constructor(@Inject(ApiHandlers) private readonly h: ApiHandlers) {}

  @Get()
  async get(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.aiSettings(toHttpRequest(req, undefined)));
  }

  @Put()
  async put(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.updateAiSettings(toHttpRequest(req, body)));
  }
}

@Controller("api/organization/integrations")
export class IntegrationController {
  constructor(@Inject(ApiHandlers) private readonly h: ApiHandlers) {}

  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.listIntegrations(toHttpRequest(req, undefined)));
  }

  @Post()
  async create(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.createIntegration(toHttpRequest(req, body)));
  }

  @Post(":id/rotate")
  @HttpCode(200)
  async rotate(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.rotateIntegration(toHttpRequest(req, undefined)));
  }

  @Delete(":id")
  async revoke(@Req() req: Request, @Res() res: Response) {
    return send(res, await this.h.revokeIntegration(toHttpRequest(req, undefined)));
  }
}

/** Injection token for the webhook body limit (bytes); configured by WEBHOOK_BODY_LIMIT_BYTES. */
export const WEBHOOK_BODY_LIMIT = Symbol("WEBHOOK_BODY_LIMIT");

/**
 * Server-to-server endpoints. No session cookie, no Origin check, no framework body parser: the global JSON parser skips
 * this path (see configure-http.ts) and the handler reads the body itself, after authentication, with its own limit.
 */
@Controller("api/v1/integrations")
export class IntegrationWebhookController {
  constructor(
    @Inject(AlertWebhookHandlers) private readonly h: AlertWebhookHandlers,
    @Inject(WEBHOOK_BODY_LIMIT) private readonly limitBytes: number,
  ) {}

  @Post("alertmanager")
  @HttpCode(200)
  async alertmanager(@Req() req: Request, @Res() res: Response) {
    return send(
      res,
      await this.h.alertmanager({
        ip: req.ip ?? "unknown",
        headers: req.headers,
        readJson: () => readJsonBody(req, { limitBytes: this.limitBytes }),
      }),
    );
  }
}
