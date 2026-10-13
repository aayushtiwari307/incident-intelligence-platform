import assert from "node:assert/strict";
import { DEFAULT_SCRYPT_PARAMS, PasswordHasher } from "./password";

// Cheap parameters keep the suite fast; production parameters are asserted separately below.
const fast = new PasswordHasher({ N: 2 ** 10, r: 8, p: 1 });

describe("PasswordHasher", () => {
  it("uses the documented production parameters by default", () => {
    assert.deepEqual(DEFAULT_SCRYPT_PARAMS, { N: 32768, r: 8, p: 3 });
  });

  it("hashes to a self-describing string and never contains the password", async () => {
    const stored = await fast.hash("correct horse battery staple");
    assert.match(stored, /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.ok(!stored.includes("correct horse"));
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const stored = await fast.hash("correct horse battery staple");
    assert.equal(await fast.verify("correct horse battery staple", stored), true);
    assert.equal(await fast.verify("correct horse battery stapl", stored), false);
    assert.equal(await fast.verify("", stored), false);
  });

  it("salts every hash: the same password gives different strings that both verify", async () => {
    const [a, b] = await Promise.all([fast.hash("same password 123"), fast.hash("same password 123")]);
    assert.notEqual(a, b);
    assert.equal(await fast.verify("same password 123", a), true);
    assert.equal(await fast.verify("same password 123", b), true);
  });

  it("treats canonically equivalent Unicode as the same password (NFKC)", async () => {
    const composed = "café-password-1";
    const decomposed = "café-password-1";
    const stored = await fast.hash(composed);
    assert.equal(await fast.verify(decomposed, stored), true);
  });

  it("returns false (never throws) for malformed stored values", async () => {
    for (const bad of ["", "plaintext", "scrypt$x$y$z$a$b", "bcrypt$1$2$3$AAAA$BBBB", "scrypt$1024$8$1$$"]) {
      assert.equal(await fast.verify("anything", bad), false, bad);
    }
  });

  it("refuses absurd cost parameters from a stored row instead of burning CPU/memory on them", async () => {
    const huge = "scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(32).toString("base64");
    const start = Date.now();
    assert.equal(await fast.verify("x", huge), false);
    assert.ok(Date.now() - start < 500, "must reject without computing");
    const notPowerOfTwo = "scrypt$1000$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(32).toString("base64");
    assert.equal(await fast.verify("x", notPowerOfTwo), false);
  });

  it("detects hashes made with weaker parameters than the current ones", async () => {
    const stored = await fast.hash("some password 123");
    assert.equal(fast.needsRehash(stored), false);
    const stronger = new PasswordHasher({ N: 2 ** 11, r: 8, p: 1 });
    assert.equal(stronger.needsRehash(stored), true);
    assert.equal(stronger.needsRehash("garbage"), true);
  });

  it("verifyDummy takes comparable time to a real verification and always returns false", async () => {
    const stored = await fast.hash("real password 123");
    const t0 = process.hrtime.bigint();
    await fast.verify("wrong password 123", stored);
    const real = Number(process.hrtime.bigint() - t0) / 1e6;
    await fast.verifyDummy("warm up"); // first call also computes the dummy hash
    const t1 = process.hrtime.bigint();
    const result = await fast.verifyDummy("wrong password 123");
    const dummy = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.equal(result, false);
    assert.ok(dummy > real / 4 && dummy < real * 4 + 20, `dummy ${dummy.toFixed(1)}ms vs real ${real.toFixed(1)}ms`);
  });
});
