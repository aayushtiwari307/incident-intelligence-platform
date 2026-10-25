import assert from "node:assert/strict";
import test from "node:test";
import { validateSmokeUrl } from "./smoke-realtime.mjs";

test("read-only realtime smoke URL requires safe HTTP(S) origin with no secrets or query", () => {
  assert.equal(validateSmokeUrl("https://api.example.test/api/anything"), "https://api.example.test");
  assert.equal(validateSmokeUrl("http://127.0.0.1:3001"), "http://127.0.0.1:3001");
  assert.throws(() => validateSmokeUrl("http://api.example.test"), /cleartext HTTP/);
  assert.throws(() => validateSmokeUrl("https://user:secret@api.example.test"), /credentials/);
  assert.throws(() => validateSmokeUrl("https://api.example.test?key=secret"), /query/);
});
