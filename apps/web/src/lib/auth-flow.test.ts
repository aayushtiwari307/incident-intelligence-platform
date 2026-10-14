import assert from "node:assert/strict";
import type { MeDto } from "@platform/shared";
import { ApiError } from "./api-client";
import { SESSION_MISMATCH, SESSION_NOT_ESTABLISHED, verifySession } from "./auth-flow";

const me = (userId: string): MeDto => ({ user: { id: userId, email: "a@example.com", displayName: "A" }, memberships: [], activeOrganizationId: null, role: null }) as unknown as MeDto;

describe("verifySession (R6: never treat a sign-in as complete until /api/auth/me agrees)", () => {
  it("accepts a working session for the account that just signed in, and returns the server's view of it", async () => {
    let calls = 0;
    const result = await verifySession(async () => (calls++, me("u1")), "u1");
    assert.equal(calls, 1);
    assert.deepEqual(result, { ok: true, me: me("u1") });
  });

  it("reports a 401 (cookie dropped or not sent) as an error instead of a signed-in state", async () => {
    const result = await verifySession(async () => { throw new ApiError(401, "UNAUTHENTICATED", "Sign in required"); }, "u1");
    assert.deepEqual(result, { ok: false, message: SESSION_NOT_ESTABLISHED });
  });

  it("refuses a session that belongs to a different account (stale cookie)", async () => {
    const result = await verifySession(async () => me("someone-else"), "u1");
    assert.deepEqual(result, { ok: false, message: SESSION_MISMATCH });
  });

  it("reports network and server failures as errors, with the API's own message and without throwing", async () => {
    const network = await verifySession(async () => { throw new ApiError(0, "NETWORK", "Could not reach the server."); }, "u1");
    assert.equal(network.ok, false);
    assert.match(network.ok ? "" : network.message, /could not be confirmed \(Could not reach the server\.\)/);
    const server = await verifySession(async () => { throw new ApiError(500, "INTERNAL", "Internal error"); }, "u1");
    assert.equal(server.ok, false);
    const odd = await verifySession(async () => { throw new TypeError("boom: secret-token-123"); }, "u1");
    assert.equal(odd.ok, false);
    assert.ok(!JSON.stringify(odd).includes("secret-token-123"), "unexpected error text must not be echoed");
  });

  it("explains the likely causes without suggesting anything unsafe", () => {
    assert.match(SESSION_NOT_ESTABLISHED, /did not keep the session/);
    assert.match(SESSION_NOT_ESTABLISHED, /https/);
    assert.doesNotMatch(SESSION_NOT_ESTABLISHED, /disable|ignore|SameSite=None/i);
  });
});
