import assert from "node:assert/strict";
import { FORCE_EXIT_TIMEOUT_MS, createShutdownHandler, scheduleForceExit } from "./shutdown";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("graceful shutdown deadline", () => {
  it("keeps the reference project's 50 second default", () => {
    assert.equal(FORCE_EXIT_TIMEOUT_MS, 50_000);
  });

  it("does not exit before the deadline and exits exactly once after it", async () => {
    let calls = 0;
    scheduleForceExit(() => {
      calls += 1;
    }, 60);

    await sleep(20);
    assert.equal(calls, 0);

    await sleep(120);
    assert.equal(calls, 1);
  });

  it("can be cancelled once shutdown completes", async () => {
    let calls = 0;
    const timer = scheduleForceExit(() => {
      calls += 1;
    }, 40);
    clearTimeout(timer);
    await sleep(100);
    assert.equal(calls, 0);
  });

  it("does not keep the process alive by itself (timer is unref'ed)", () => {
    const timer = scheduleForceExit(() => undefined, 10_000);
    assert.equal(timer.hasRef(), false);
    clearTimeout(timer);
  });
});

describe("createShutdownHandler lifecycle", () => {
  function harness(close: () => Promise<void>, timeoutMs = 80) {
    const exits: number[] = [];
    const codes: number[] = [];
    const logs: string[] = [];
    const handler = createShutdownHandler({
      close,
      log: (m) => void logs.push(m),
      exit: (c) => void exits.push(c),
      setExitCode: (c) => void codes.push(c),
      timeoutMs,
    });
    return { handler, exits, codes, logs };
  }

  it("on a clean shutdown it clears the timer: the forced exit never fires afterwards", async () => {
    const h = harness(async () => sleep(10), 60);
    await h.handler("SIGTERM");
    assert.deepEqual(h.codes, [0]);
    await sleep(150); // well past the deadline
    assert.deepEqual(h.exits, [], "force exit must not fire after shutdown completed");
  });

  it("forces exit with code 1 exactly once if close() overruns the deadline", async () => {
    const h = harness(() => new Promise(() => undefined), 50);
    void h.handler("SIGTERM");
    await sleep(40);
    assert.deepEqual(h.exits, []);
    await sleep(120);
    assert.deepEqual(h.exits, [1]);
    assert.deepEqual(h.codes, []);
  });

  it("a failing close() exits 1 immediately and clears the timer (no second exit later)", async () => {
    const h = harness(async () => {
      throw new Error("pool refused to close");
    }, 60);
    await h.handler("SIGINT");
    assert.deepEqual(h.exits, [1]);
    await sleep(150);
    assert.deepEqual(h.exits, [1]);
  });

  it("ignores a repeated signal: close() runs once and only one timer exists", async () => {
    let closes = 0;
    const h = harness(async () => {
      closes += 1;
      await sleep(30);
    }, 60);
    await Promise.all([h.handler("SIGINT"), h.handler("SIGTERM"), h.handler("SIGINT")]);
    assert.equal(closes, 1);
    assert.deepEqual(h.codes, [0]);
    assert.equal(h.logs.filter((m) => m.startsWith("shutdown already")).length, 2);
    await sleep(120);
    assert.deepEqual(h.exits, []);
  });
});
