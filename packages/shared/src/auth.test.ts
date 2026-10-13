import assert from "node:assert/strict";
import { PASSWORD_MAX_CHARS, loginSchema, passwordSchema, registerSchema, registerWithInviteSchema } from "./auth";

const valid = {
  email: "  Jane.Doe@Example.COM ",
  password: "correct horse battery",
  displayName: "  Jane Doe ",
  organizationName: " Acme Ops ",
};

describe("registerSchema", () => {
  it("normalises email (trim + lowercase) and trims names", () => {
    const parsed = registerSchema.parse(valid);
    assert.equal(parsed.email, "jane.doe@example.com");
    assert.equal(parsed.displayName, "Jane Doe");
    assert.equal(parsed.organizationName, "Acme Ops");
  });

  it("rejects unknown fields (no mass-assignment of e.g. role)", () => {
    assert.equal(registerSchema.safeParse({ ...valid, role: "owner" }).success, false);
  });

  it("rejects missing fields and wrong types", () => {
    assert.equal(registerSchema.safeParse({}).success, false);
    assert.equal(registerSchema.safeParse({ ...valid, email: 123 }).success, false);
    assert.equal(registerSchema.safeParse(null).success, false);
    assert.equal(registerSchema.safeParse("string").success, false);
  });

  it("rejects malformed email addresses", () => {
    for (const email of ["", "no-at-sign", "a@", "@b.com", "a b@c.com", "x".repeat(250) + "@example.com"]) {
      assert.equal(registerSchema.safeParse({ ...valid, email }).success, false, email);
    }
  });

  it("rejects empty or oversized names", () => {
    assert.equal(registerSchema.safeParse({ ...valid, displayName: "   " }).success, false);
    assert.equal(registerSchema.safeParse({ ...valid, displayName: "x".repeat(81) }).success, false);
    assert.equal(registerSchema.safeParse({ ...valid, organizationName: "x".repeat(121) }).success, false);
  });
});

describe("passwordSchema", () => {
  it("enforces the minimum length", () => {
    assert.equal(passwordSchema.safeParse("a".repeat(11)).success, false);
    assert.equal(passwordSchema.safeParse("a".repeat(12)).success, true);
  });

  it("accepts long passphrases up to the character cap (scrypt uses the whole input; bcrypt's 72-byte limit no longer applies)", () => {
    assert.equal(passwordSchema.safeParse("a".repeat(73)).success, true);
    assert.equal(passwordSchema.safeParse("a".repeat(PASSWORD_MAX_CHARS)).success, true);
    assert.equal(passwordSchema.safeParse("a".repeat(PASSWORD_MAX_CHARS + 1)).success, false);
  });

  it("counts characters, not bytes: 100 three-byte characters are accepted", () => {
    const euro = "€".repeat(100); // 100 characters, 300 UTF-8 bytes
    assert.equal(euro.length, 100);
    assert.equal(passwordSchema.safeParse(euro).success, true);
  });

  it("rejects absurdly long input", () => {
    assert.equal(passwordSchema.safeParse("a".repeat(100_000)).success, false);
  });
});

describe("loginSchema", () => {
  it("does not reveal or enforce the registration password policy", () => {
    assert.equal(loginSchema.safeParse({ email: "a@b.co", password: "short" }).success, true);
  });

  it("still bounds input size and requires a password", () => {
    assert.equal(loginSchema.safeParse({ email: "a@b.co", password: "" }).success, false);
    assert.equal(loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(129) }).success, false);
    assert.equal(loginSchema.safeParse({ email: "a@b.co" }).success, false);
  });

  it("rejects unknown fields", () => {
    assert.equal(loginSchema.safeParse({ email: "a@b.co", password: "x", remember: true }).success, false);
  });
});


describe("registerWithInviteSchema", () => {
  const validInvite = {
    email: "  member@Example.com ",
    password: "correct horse battery",
    displayName: " Member ",
    inviteToken: "a".repeat(43),
  };

  it("normalizes the email and display name without requiring an organization name", () => {
    const parsed = registerWithInviteSchema.parse(validInvite);
    assert.equal(parsed.email, "member@example.com");
    assert.equal(parsed.displayName, "Member");
    assert.equal(parsed.inviteToken, "a".repeat(43));
  });

  it("rejects short tokens and unknown fields", () => {
    assert.equal(registerWithInviteSchema.safeParse({ ...validInvite, inviteToken: "short" }).success, false);
    assert.equal(registerWithInviteSchema.safeParse({ ...validInvite, organizationId: "other-org" }).success, false);
  });
});
