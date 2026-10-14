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

  /** Ready to take traffic: the database answers. Redis is not used by the API, so it is not checked; add it here if that ever changes. */
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
