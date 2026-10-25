import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  SmokeFailure,
  classifyUnauthenticated,
  foreignOriginRefused,
  parseExpectation,
  parseTarget,
  parseWakeTimeout,
  run,
  waitForHealth,
} from "./smoke-public-realtime.mjs";

describe("parseTarget", () => {
  it("accepts an https origin and normalises it", () => {
    assert.equal(parseTarget("https://demo.onrender.com"), "https://demo.onrender.com");
    assert.equal(parseTarget(" https://demo.onrender.com/ "), "https://demo.onrender.com");
  });
  it("accepts http only for loopback", () => {
    assert.equal(parseTarget("http://127.0.0.1:3001"), "http://127.0.0.1:3001");
    assert.equal(parseTarget("http://localhost:8080"), "http://localhost:8080");
    assert.throws(() => parseTarget("http://demo.onrender.com"), SmokeFailure);
  });
  it("rejects credentials, paths, queries, fragments, junk and missing values", () => {
    for (const bad of ["https://user:pw@demo.onrender.com", "https://demo.onrender.com/api", "https://demo.onrender.com/?a=1", "https://demo.onrender.com/#x", "not a url", "", undefined, "ftp://demo.onrender.com"]) {
      assert.throws(() => parseTarget(bad), SmokeFailure, String(bad));
    }
  });
  it("never echoes a rejected URL (it could carry a credential)", () => {
    try {
      parseTarget("https://user:topsecret@demo.onrender.com");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(!String(error.message).includes("topsecret"));
    }
  });
});

describe("option parsing", () => {
  it("EXPECT_REALTIME defaults to on and refuses anything but on/off", () => {
    assert.equal(parseExpectation(undefined), "on");
    assert.equal(parseExpectation(" OFF "), "off");
    assert.throws(() => parseExpectation("maybe"), SmokeFailure);
  });
  it("WAKE_TIMEOUT_SECONDS is bounded", () => {
    assert.equal(parseWakeTimeout(undefined), 120);
    assert.equal(parseWakeTimeout("30"), 30);
    for (const bad of ["4", "301", "abc", "1.5", "-1"]) assert.throws(() => parseWakeTimeout(bad), SmokeFailure, bad);
  });
});

describe("classification", () => {
  it("an UNAUTHENTICATED refusal means real-time is enabled", () => {
    assert.equal(classifyUnauthenticated({ connected: false, errored: true, errorCode: "UNAUTHENTICATED" }), "enabled");
  });
  it("a transport error without an application code means real-time is not served", () => {
    assert.equal(classifyUnauthenticated({ connected: false, errored: true, errorCode: undefined }), "disabled");
  });
  it("a successful connection, a silent timeout or another code is unexpected (never a pass)", () => {
    assert.equal(classifyUnauthenticated({ connected: true, errored: false }), "unexpected");
    assert.equal(classifyUnauthenticated({ connected: false, errored: false }), "unexpected");
    assert.equal(classifyUnauthenticated({ connected: false, errored: true, errorCode: "UNAVAILABLE" }), "unexpected");
  });
  it("a foreign origin that connects or becomes ready is a failure", () => {
    assert.equal(foreignOriginRefused({ connected: false, ready: false }), true);
    assert.equal(foreignOriginRefused({ connected: true, ready: false }), false);
    assert.equal(foreignOriginRefused({ connected: false, ready: true }), false);
  });
});

describe("waitForHealth (free-tier wake-up)", () => {
  it("polls until the endpoint answers 200", async () => {
    const answers = [0, 502, 200];
    let t = 0;
    const result = await waitForHealth("https://x", 60_000, { fetchOnce: async () => answers.shift(), pause: async () => void (t += 5_000), now: () => t });
    assert.equal(result.ok, true);
    assert.equal(answers.length, 0);
  });
  it("gives up at the deadline and reports the last status", async () => {
    let t = 0;
    const result = await waitForHealth("https://x", 12_000, { fetchOnce: async () => 503, pause: async () => void (t += 5_000), now: () => t });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  });
});

/** A scripted fake socket.io client: `script(headers)` returns the events to fire for that handshake. */
function fakeOpen(script) {
  return (_origin, options) => {
    const socket = new EventEmitter();
    socket.close = () => undefined;
    setImmediate(() => {
      for (const [event, payload] of script(options.extraHeaders)) socket.emit(event, payload);
    });
    return socket;
  };
}

/** Starts a real run() against fakes. fetch is replaced so no network is touched. */
async function runWith(env, script) {
  const lines = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200 });
  try {
    const code = await run(env, { open: fakeOpen(script), log: (line) => lines.push(line) });
    return { code, text: lines.join("\n") };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const GOOD = (headers) => {
  if (headers.Origin !== "https://demo.onrender.com") return [["connect_error", { data: { code: "FORBIDDEN_ORIGIN" } }]];
  if (!headers.Cookie) return [["connect_error", { data: { code: "UNAUTHENTICATED" } }]];
  return [["connect", undefined], ["realtime.ready", {}]];
};

describe("run (fake sockets, fake fetch)", () => {
  const env = { PUBLIC_URL: "https://demo.onrender.com" };

  it("passes when real-time is enabled, unauthenticated sockets are refused and foreign origins are refused", async () => {
    const r = await runWith(env, GOOD);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /PASS/);
  });

  it("with a session cookie, also requires realtime.ready, and never prints the cookie", async () => {
    const cookie = "sid=VERY-SECRET-COOKIE-VALUE";
    const r = await runWith({ ...env, SMOKE_SESSION_COOKIE: cookie }, GOOD);
    assert.equal(r.code, 0, r.text);
    assert.ok(!r.text.includes("VERY-SECRET-COOKIE-VALUE"));
    assert.match(r.text, /authenticated socket receives realtime\.ready/);
  });

  it("FAILS when real-time is not served but was expected", async () => {
    const r = await runWith(env, () => [["connect_error", { message: "websocket error" }]]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.text, /PASS/);
  });

  it("EXPECT_REALTIME=off passes only when real-time is really not served", async () => {
    const off = { ...env, EXPECT_REALTIME: "off" };
    assert.equal((await runWith(off, () => [["connect_error", { message: "websocket error" }]])).code, 0);
    assert.equal((await runWith(off, GOOD)).code, 1, "an enabled endpoint must fail an 'off' expectation");
  });

  it("FAILS if an unauthenticated socket is ever accepted", async () => {
    const r = await runWith(env, () => [["connect", undefined], ["realtime.ready", {}]]);
    assert.equal(r.code, 1);
  });

  it("FAILS if a foreign origin is accepted", async () => {
    const r = await runWith(env, (headers) => (headers.Origin === "https://evil.example" ? [["connect", undefined], ["realtime.ready", {}]] : GOOD(headers)));
    assert.equal(r.code, 1);
  });

  it("rejects an unsafe target before touching the network", async () => {
    await assert.rejects(runWith({ PUBLIC_URL: "http://demo.onrender.com" }, GOOD), SmokeFailure);
  });
});
