import { Global, Module } from "@nestjs/common";
import type { AppConfig } from "./env";

export const APP_CONFIG = Symbol("APP_CONFIG");

/** Config is loaded and validated once in main.ts, before Nest starts, and injected from there. */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig) {
    return { module: ConfigModule, providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] };
  }
}
