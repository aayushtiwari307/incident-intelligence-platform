import assert from "node:assert/strict";
import { generateToken, hashToken } from "./tokens";

describe("session and invite tokens", () => {
  it("are 256-bit URL-safe strings and never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const token = generateToken();
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!seen.has(token));
      seen.add(token);
    }
  });

  it("hash deterministically to 64 hex characters that differ from the token", () => {
    const token = generateToken();
    const hash = hashToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hashToken(token), hash);
    assert.notEqual(hashToken(token + "x"), hash);
    assert.ok(!hash.includes(token));
  });

  it("match the known SHA-256 of a fixed input (guards against an accidental algorithm change)", () => {
    assert.equal(hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
