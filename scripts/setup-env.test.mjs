import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildEnvFiles } from "./setup-env.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const templates = { root: read(".env.example"), api: read("apps/api/.env.example"), web: read("apps/web/.env.example") };
const out = buildEnvFiles(templates, "pgpass0123", "redispass9");
const value = (text, key) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1];

test("the real templates still contain the placeholders this script replaces", () => {
  assert.match(templates.root, /^POSTGRES_PASSWORD=dev_only_change_me$/m);
  assert.match(templates.root, /^REDIS_PASSWORD=dev_only_change_me$/m);
  assert.match(templates.api, /^DATABASE_URL=.*dev_only_change_me/m);
  assert.match(templates.api, /^REDIS_URL=.*dev_only_change_me/m);
});

test("passwords match between the compose .env and the API's connection URLs", () => {
  assert.equal(value(out.root, "POSTGRES_PASSWORD"), "pgpass0123");
  assert.equal(value(out.root, "REDIS_PASSWORD"), "redispass9");
  assert.equal(new URL(value(out.api, "DATABASE_URL")).password, "pgpass0123");
  assert.equal(new URL(value(out.api, "REDIS_URL")).password, "redispass9");
});

test("no placeholder password survives, and unrelated lines are untouched", () => {
  assert.doesNotMatch(out.root + out.api, /dev_only_change_me/);
  assert.equal(value(out.api, "API_HOST"), "127.0.0.1");
  assert.equal(value(out.root, "POSTGRES_USER"), "platform");
  assert.equal(out.web, templates.web);
});

test("the API CORS origins cover both spellings of the web dev server address", () => {
  const origins = value(out.api, "CORS_ORIGINS").split(",");
  assert.ok(origins.includes("http://localhost:3000") && origins.includes("http://127.0.0.1:3000"));
});
