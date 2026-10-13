import assert from "node:assert/strict";
import { redactSecrets, redactUrl, redactValue } from "./redact";

// Fake credentials are assembled at runtime so the repo hygiene scanner does not flag this file.
const fake = {
  openai: "sk-" + "a1B2c3D4e5F6g7H8i9J0",
  github: "ghp_" + "A".repeat(36),
  githubPat: "github_pat_" + "B".repeat(30),
  google: "AIza" + "c".repeat(35),
  jwt: ["eyJhbGciOi" + "JIUzI1NiJ9", "eyJzdWIiOi" + "IxMjM0NTY3ODkwIn0", "dBjftJeZ4CVP" + "mB92K27uhbUJU1p1r"].join("."),
};

describe("redactSecrets", () => {
  it("masks each known credential shape", () => {
    for (const [name, secret] of Object.entries(fake)) {
      const out = redactSecrets(`failed calling provider with ${secret} again`);
      assert.ok(!out.includes(secret), `${name} not redacted: ${out}`);
      assert.match(out, /REDACTED/);
    }
  });

  it("masks Bearer tokens and key=value pairs", () => {
    assert.ok(!redactSecrets("Authorization: Bearer abc.def.ghi").includes("abc.def.ghi"));
    assert.ok(!redactSecrets("api_key=hunter2 other").includes("hunter2"));
    assert.ok(!redactSecrets("password: hunter2").includes("hunter2"));
    assert.ok(redactSecrets("api_key=hunter2 other").includes("other"));
  });

  it("masks passwords embedded in URLs but keeps the host", () => {
    const out = redactSecrets("connect ECONNREFUSED postgresql://platform:hunter2@db.internal:5432/platform");
    assert.ok(!out.includes("hunter2"));
    assert.ok(out.includes("db.internal"));
  });

  it("collapses whitespace and bounds length", () => {
    assert.equal(redactSecrets("a \n\n  b"), "a b");
    assert.equal(redactSecrets("x".repeat(100), 10).length, 10);
  });

  it("leaves ordinary text alone", () => {
    assert.equal(redactSecrets("deployment 8f91 finished in 42s"), "deployment 8f91 finished in 42s");
  });
});

describe("redactUrl", () => {
  it("masks only the password", () => {
    const out = redactUrl("postgresql://platform:hunter2@127.0.0.1:5434/platform");
    assert.ok(!out.includes("hunter2"));
    assert.ok(out.includes("platform@127.0.0.1:5434/platform") || out.includes("platform:REDACTED@127.0.0.1:5434/platform"));
  });

  it("does not throw on garbage", () => {
    assert.equal(redactUrl("::::"), "[unparseable url]");
  });
});

describe("redactValue", () => {
  it("masks values under sensitive keys at any depth and redacts strings", () => {
    const out = redactValue({
      user: "jane",
      password: "hunter2",
      nested: { Authorization: "Bearer xyz", apiKey: "k", note: `token ${fake.openai}` },
      list: [{ secret: "s" }, "plain"],
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    for (const leaked of ["hunter2", "Bearer xyz", fake.openai, '"s"']) assert.ok(!text.includes(leaked), leaked);
    assert.ok(text.includes("jane"));
    assert.ok(text.includes("plain"));
  });

  it("summarises errors without stack traces and redacts their messages", () => {
    const out = redactValue(new Error(`boom ${fake.github}`)) as { name: string; message: string };
    assert.equal(out.name, "Error");
    assert.ok(!out.message.includes(fake.github));
  });

  it("is safe on cyclic structures", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => redactValue(cyclic));
  });

  it("passes primitives through", () => {
    assert.equal(redactValue(42), 42);
    assert.equal(redactValue(null), null);
    assert.equal(redactValue(true), true);
  });
});
