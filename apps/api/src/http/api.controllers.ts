import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiHandlers } from "./api-handlers";
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

  @Patch(":id")
  async update(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    return send(res, await this.h.updateIncident(toHttpRequest(req, body)));
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
}
