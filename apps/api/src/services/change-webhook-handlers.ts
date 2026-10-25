import type { HttpRequest, HttpResult } from "../http/http-types";
import type { ServiceCatalogService } from "./service-catalog.service";

export interface ChangeWebhookRequest {
  ip: string;
  headers: HttpRequest["headers"];
  readJson(): Promise<unknown>;
}

const NO_STORE = { "Cache-Control": "no-store" };
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,128})$/;

/** Change-event server-to-server endpoint. The body is not read until its bearer credential has been validated. */
export class ChangeWebhookHandlers {
  constructor(private readonly services: ServiceCatalogService) {}

  async changeEvent(req: ChangeWebhookRequest): Promise<HttpResult> {
    const value = req.headers.authorization;
    const match = typeof value === "string" ? BEARER.exec(value) : null;
    const result = await this.services.ingestChange(match?.[1] ?? "", req.ip, req.readJson);
    return { status: 200, body: result, headers: NO_STORE };
  }
}
