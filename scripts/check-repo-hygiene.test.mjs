import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  envVariableNames,
  findCredentialPatterns,
  findSecretyFrontendVars,
  findTrackedArchives,
  findTrackedEnvFiles,
} from "./check-repo-hygiene.mjs";

describe("findTrackedEnvFiles", () => {
  it("flags real env files but allows .env.example", () => {
    const files = [".env", "apps/api/.env", "apps/web/.env.local", ".env.production", ".env.example", "apps/api/.env.example", "docs/env.md"];
    assert.deepEqual(findTrackedEnvFiles(files), [".env", "apps/api/.env", "apps/web/.env.local", ".env.production"]);
  });
});

describe("findTrackedArchives", () => {
  it("flags archives (the reference ZIP shipped real .env files)", () => {
    assert.deepEqual(findTrackedArchives(["a.zip", "b.TGZ", "src/x.ts", "c.tar.gz"]), ["a.zip", "b.TGZ", "c.tar.gz"]);
  });
});

describe("frontend env secrets", () => {
  it("parses variable names, ignoring comments and blank values", () => {
    const text = "# comment\nNEXT_PUBLIC_API_URL=http://localhost:3001\n\nexport FOO=bar\n  BAZ = 1\n";
    assert.deepEqual(envVariableNames(text), ["NEXT_PUBLIC_API_URL", "FOO", "BAZ"]);
  });

  it("flags secret-looking names but not the public API URL", () => {
    const text = "NEXT_PUBLIC_API_URL=http://x\nNEXT_PUBLIC_STRIPE_SECRET=1\nOPENAI_API_KEY=\nDB_PASSWORD=x\nAUTH_TOKEN=y\n";
    assert.deepEqual(findSecretyFrontendVars(text), ["NEXT_PUBLIC_STRIPE_SECRET", "OPENAI_API_KEY", "DB_PASSWORD", "AUTH_TOKEN"]);
  });
});

describe("findCredentialPatterns", () => {
  it("detects common credential shapes", () => {
    const fake = {
      openai: "sk-" + "a".repeat(24),
      github: "ghp_" + "A".repeat(36),
      google: "AIza" + "b".repeat(35),
      key: "-----BEGIN " + "PRIVATE KEY-----",
      aws: "AKIA" + "ABCDEFGHIJKLMNOP",
    };
    assert.deepEqual(findCredentialPatterns(fake.openai), ["OpenAI-style key"]);
    assert.deepEqual(findCredentialPatterns(fake.github), ["GitHub token"]);
    assert.deepEqual(findCredentialPatterns(fake.google), ["Google API key"]);
    assert.deepEqual(findCredentialPatterns(fake.key), ["private key block"]);
    assert.deepEqual(findCredentialPatterns(fake.aws), ["AWS access key id"]);
  });

  it("does not flag ordinary text or short placeholders", () => {
    assert.deepEqual(findCredentialPatterns("OPENAI_API_KEY=sk-replace-me\nPOSTGRES_PASSWORD=dev_only_change_me"), []);
    assert.deepEqual(findCredentialPatterns("const skate = 'sk-8'; ghp is not a token"), []);
  });
});
