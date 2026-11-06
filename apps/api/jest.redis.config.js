/** Dedicated mandatory real-Redis tests; CI provides the Redis service on 127.0.0.1:6379. */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
  testMatch: ["<rootDir>/src/**/*.redis.test.ts"],
  testTimeout: 30000,
};
