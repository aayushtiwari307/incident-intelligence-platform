import assert from "node:assert/strict";
import { isRealtimeOriginAllowed } from "./origin";

const ALLOWED = ["http://127.0.0.1:3000", "https://app.example.com"];

describe("isRealtimeOriginAllowed", () => {
  it("allows listed origins", () => {
    assert.equal(isRealtimeOriginAllowed("http://127.0.0.1:3000", ALLOWED), true);
    assert.equal(isRealtimeOriginAllowed("https://app.example.com", ALLOWED), true);
  });

  it("rejects an unlisted origin, including another port on a listed host and a look-alike", () => {
    assert.equal(isRealtimeOriginAllowed("http://127.0.0.1:3999", ALLOWED), false);
    assert.equal(isRealtimeOriginAllowed("https://app.example.com.evil.test", ALLOWED), false);
    assert.equal(isRealtimeOriginAllowed("http://app.example.com", ALLOWED), false);
  });

  it("rejects Origin: null (sandboxed frames) and the empty string", () => {
    assert.equal(isRealtimeOriginAllowed("null", ALLOWED), false);
    assert.equal(isRealtimeOriginAllowed("", ALLOWED), false);
  });

  it("allows a missing Origin (a non-browser client, which still needs a valid session cookie)", () => {
    assert.equal(isRealtimeOriginAllowed(undefined, ALLOWED), true);
  });

  it("rejects every browser origin when none are configured", () => {
    assert.equal(isRealtimeOriginAllowed("http://127.0.0.1:3000", []), false);
  });
});
