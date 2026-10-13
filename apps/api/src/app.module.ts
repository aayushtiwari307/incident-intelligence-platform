import { Module, type DynamicModule } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import type { AppConfig } from "./config/env";
import { DatabaseModule } from "./db/database.module";
import { ApiModule } from "./http/api.module";
import { HealthController } from "./health/health.controller";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule, ApiModule],
      controllers: [HealthController],
    };
  }
}
