import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { DatabaseService } from "../db/database.service";

@Controller("health")
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  /** Process is up. Never touches dependencies, so an orchestrator does not restart it for a database blip. */
  @Get("live")
  live() {
    return { status: "ok" };
  }

  /** Readiness reflects the database. Redis is optional for startup; configured limiter outages follow per-policy fail-open/closed behavior. */
  @Get("ready")
  async ready() {
    try {
      await this.db.ping();
    } catch {
      throw new ServiceUnavailableException({ status: "unavailable", database: "down" });
    }
    return { status: "ok", database: "up" };
  }
}
