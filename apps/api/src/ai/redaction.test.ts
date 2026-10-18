import assert from "node:assert/strict";
import { redactForProvider, totalRedactions } from "./redaction";

// Secret-shaped fixtures are assembled at runtime so no key-shaped literal sits in the repository.
const join = (...parts: string[]) => parts.join("");
const OPENAI_KEY = join("sk", "-", "proj-", "abcdefghijklmnop1234");
const GITHUB_TOKEN = join("gh", "p_", "a".repeat(36));
const AWS_KEY = join("AKI", "A", "ABCDEFGHIJKLMNOP");
const JWT = join("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
const PASSWORD = "hunter2-correct-horse";

describe("outbound redaction (best effort)", () => {
  it("removes email addresses", () => {
    const r = redactForProvider("Contact jane.doe+oncall@example.co.uk or ops@corp.io about the outage");
    assert.equal(r.text, "Contact [REDACTED_EMAIL] or [REDACTED_EMAIL] about the outage");
    assert.equal(r.counts.email, 2);
  });

  it("removes bearer tokens and Authorization header values", () => {
    const bearer = redactForProvider(`curl -H "Authorization: Bearer abc123def456ghi789" https://api.example.com`);
    assert.ok(!bearer.text.includes("abc123def456ghi789"));
    assert.ok(bearer.counts.bearer_token >= 1);
    const bare = redactForProvider("the client sent Bearer 0123456789abcdef0123456789abcdef today");
    assert.ok(!bare.text.includes("0123456789abcdef0123456789abcdef"));
  });

  it("removes API-key formats", () => {
    for (const secret of [OPENAI_KEY, GITHUB_TOKEN, AWS_KEY]) {
      const r = redactForProvider(`config used ${secret} for the call`);
      assert.ok(!r.text.includes(secret), `${secret.slice(0, 6)}… survived`);
      assert.equal(r.counts.api_key, 1);
    }
  });

  it("removes JWTs", () => {
    const r = redactForProvider(`session cookie value ${JWT} was rejected`);
    assert.ok(!r.text.includes("eyJ"));
    assert.equal(r.counts.jwt, 1);
  });

  it("removes password-style key/value pairs in every common spelling", () => {
    const cases = [
      `password=${PASSWORD}`,
      `PASSWORD: ${PASSWORD}`,
      `"password": "${PASSWORD}"`,
      `db_password = ${PASSWORD}`,
      `api_key=${PASSWORD}`,
      `client_secret: '${PASSWORD}'`,
      `x-api-key: ${PASSWORD}`,
    ];
    for (const input of cases) {
      const r = redactForProvider(`failed with ${input} in the config`);
      assert.ok(!r.text.includes(PASSWORD), `value survived in: ${input}`);
      assert.ok(r.counts.password_pair >= 1, `not counted: ${input}`);
    }
  });

  it("removes credentials in connection strings (the whole URL)", () => {
    for (const url of [
      `postgres://app:${PASSWORD}@db.internal:5432/orders`,
      `mongodb+srv://svc:${PASSWORD}@cluster0.example.mongodb.net/prod`,
      `redis://:${PASSWORD}@cache.internal:6379/0`,
    ]) {
      const r = redactForProvider(`connect failed: ${url} (timeout)`);
      assert.ok(!r.text.includes(PASSWORD), url);
      assert.ok(r.text.includes("[REDACTED_CONNECTION_STRING]"), url);
      assert.equal(r.counts.connection_string, 1);
    }
  });

  it("removes private-key blocks, including an unterminated one", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nKcwggSjAgEAAoIBAQC7\n";
    const whole = redactForProvider(`key pasted:\n-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\nthanks`);
    assert.ok(!whole.text.includes("MIIEvQ"));
    assert.ok(whole.text.includes("thanks"), "text after a complete block is kept");
    assert.equal(whole.counts.private_key, 1);

    const cut = redactForProvider(`-----BEGIN RSA PRIVATE KEY-----\n${body}`);
    assert.ok(!cut.text.includes("MIIEvQ"));
    assert.equal(cut.counts.private_key, 1);
  });

  it("leaves ordinary incident prose alone (false-positive guard)", () => {
    const prose = [
      "Checkout latency rose after the password reset flow was deployed; the token bucket limiter dropped requests.",
      "Basic configuration was reviewed and bearer authentication is enabled for the gateway.",
      "Service https://status.example.com:8443/health returned 503 from host db-1.internal.",
      "Risk-assessment-document and task-force notes were attached; keyboard shortcuts unaffected.",
      "Pool size 20 -> 50 fixed ERROR 1040: Too many connections at 12:04 UTC.",
    ];
    for (const text of prose) {
      const r = redactForProvider(text);
      assert.equal(r.text, text);
      assert.equal(totalRedactions(r.counts), 0);
    }
  });

  it("is deterministic and never reports the removed values", () => {
    const input = `user a@b.io key ${OPENAI_KEY} password=${PASSWORD}`;
    const first = redactForProvider(input);
    assert.deepEqual(redactForProvider(input), first);
    assert.ok(!JSON.stringify(first.counts).includes(PASSWORD));
    assert.equal(totalRedactions(first.counts), 3);
  });

  it("stays fast on adversarial input", () => {
    const hostile = ["a".repeat(90_000), "@".repeat(5000), "password=".repeat(5000), "://:".repeat(5000), "-----BEGIN PRIVATE KEY-----".repeat(500)];
    for (const input of hostile) {
      const started = Date.now();
      redactForProvider(input);
      assert.ok(Date.now() - started < 2000, "redaction must stay linear-ish");
    }
  });
});
