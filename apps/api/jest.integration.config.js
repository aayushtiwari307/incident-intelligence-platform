/**
 * Integration tests run against a REAL PostgreSQL (and, later, Redis). They are never silently
 * skipped: globalSetup fails the whole run if TEST_DATABASE_URL is not set.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
  testMatch: ["<rootDir>/src/**/*.int.test.ts"],
  globalSetup: "<rootDir>/jest.integration.setup.js",
  testTimeout: 30000,
};
