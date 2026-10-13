import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSetCookie, runSmoke, sessionCookieProblems } from "./smoke-stack.mjs";

describe("parseSetCookie / sessionCookieProblems", () => {
  it("parses name, value (which may contain '=') and attributes", () => {
    const c = parseSetCookie("__Host-sid=abc%3Ddef; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax");
    assert.equal(c.name, "__Host-sid");
    assert.equal(c.value, "abc%3Ddef");
    assert.equal(c.attributes.path, "/");
    assert.equal(c.attributes.httponly, true);
    assert.equal(c.attributes.samesite, "Lax");
  });

  it("accepts the production cookie and the development cookie", () => {
    assert.deepEqual(sessionCookieProblems(parseSetCookie("__Host-sid=x; Path=/; HttpOnly; Secure; SameSite=Lax")), []);
    assert.deepEqual(sessionCookieProblems(parseSetCookie("sid=x; Path=/; HttpOnly; SameSite=Lax")), []);
  });

  it("flags every weakening of the cookie", () => {
    assert.match(sessionCookieProblems(parseSetCookie("sid=x; Path=/; SameSite=Lax")).join(), /HttpOnly/);
    assert.match(sessionCookieProblems(parseSetCookie("sid=x; Path=/; HttpOnly; SameSite=None")).join(), /SameSite=Lax/);
    assert.match(sessionCookieProblems(parseSetCookie("__Host-sid=x; Path=/; HttpOnly; SameSite=Lax")).join(), /Secure/);
    assert.match(sessionCookieProblems(parseSetCookie("__Host-sid=x; Path=/a; HttpOnly; Secure; SameSite=Lax")).join(), /Path=\//);
    assert.match(sessionCookieProblems(parseSetCookie("__Host-sid=x; Domain=example.com; Path=/; HttpOnly; Secure; SameSite=Lax")).join(), /Domain/);
  });
});

describe("runSmoke", () => {
  it("fails fast and reports which check failed when the API misbehaves", async () => {
    const logs = [];
    const brokenFetch = async () => new Response('{"status":"down"}', { status: 503 });
    await assert.rejects(runSmoke({ apiUrl: "http://api.invalid", webUrl: null, log: (m) => logs.push(m), fetchImpl: brokenFetch }), /status 503/);
    assert.ok(logs.some((line) => line.startsWith("FAIL API liveness")));
  });
});
