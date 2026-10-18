import assert from "node:assert/strict";
import test from "node:test";
import { apiEnvironment, requiredPort } from "./runtime-config.mjs";

test("validates the public listener port and uses the documented default", () => {
  assert.equal(requiredPort(undefined, "10000", "PORT"), "10000");
  assert.equal(requiredPort("23456", "10000", "PORT"), "23456");
  for (const value of ["abc", "0", "80", "65536"]) {
    assert.throws(() => requiredPort(value, "10000", "PORT"), /PORT/);
  }
});

test("keeps the API private and adds Render's exact HTTPS origin to the CSRF allow-list", () => {
  const config = apiEnvironment({
    API_HOST: "0.0.0.0",
    API_PORT: "9",
    TRUST_PROXY_HOPS: "10",
    CORS_ORIGINS: "https://custom.example, https://custom.example",
    RENDER_EXTERNAL_URL: "https://demo.onrender.com",
    DATABASE_URL: "not logged or modified",
  });
  assert.equal(config.API_HOST, "127.0.0.1");
  assert.equal(config.API_PORT, "3001");
  assert.equal(config.TRUST_PROXY_HOPS, "1");
  assert.equal(config.CORS_ORIGINS, "https://custom.example,https://demo.onrender.com");
  assert.equal(config.DATABASE_URL, "not logged or modified");
});

test("requires Render's platform origin to be a bare HTTPS origin", () => {
  for (const value of [
    "not a URL",
    "http://demo.onrender.com",
    "https://demo.onrender.com/path",
    "https://user:password@demo.onrender.com",
  ]) {
    assert.throws(
      () => apiEnvironment({ RENDER_EXTERNAL_URL: value }),
      /RENDER_EXTERNAL_URL must be a valid HTTPS origin/,
    );
  }
});
