import assert from "node:assert/strict";
import { clearedSessionCookie, parseCookies, sessionCookie, sessionCookieName } from "./cookies";

describe("cookie parsing", () => {
  it("parses several cookies, trims, and decodes", () => {
    assert.deepEqual(parseCookies("a=1; b=hello%20world;  c=3"), { a: "1", b: "hello world", c: "3" });
  });

  it("returns an empty object for a missing header", () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(""), {});
  });

  it("skips malformed pairs and bad encodings instead of throwing", () => {
    assert.deepEqual(parseCookies("novalue; =x; ok=1; bad=%E0%A4%A"), { ok: "1" });
  });

  it("keeps the first value when a name repeats (an attacker-set later cookie cannot override)", () => {
    assert.deepEqual(parseCookies("sid=first; sid=second"), { sid: "first" });
  });

  it("strips surrounding quotes and keeps '=' inside values", () => {
    assert.deepEqual(parseCookies('q="abc"; e=a=b'), { q: "abc", e: "a=b" });
  });
});

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Lax, path /, with the __Host- prefix only when Secure", () => {
    assert.equal(sessionCookieName(true), "__Host-sid");
    assert.equal(sessionCookieName(false), "sid");
    const c = sessionCookie("tok", { secure: true, maxAgeSeconds: 3600 });
    assert.equal(c.name, "__Host-sid");
    assert.deepEqual(c.options, { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 3_600_000 });
  });

  it("has no Domain attribute (required by the __Host- prefix and keeps it host-only)", () => {
    assert.ok(!("domain" in sessionCookie("t", { secure: true, maxAgeSeconds: 1 }).options));
  });

  it("is cleared with the same attributes", () => {
    const c = clearedSessionCookie(false);
    assert.equal(c.name, "sid");
    assert.equal(c.options.httpOnly, true);
    assert.equal(c.options.path, "/");
  });
});
