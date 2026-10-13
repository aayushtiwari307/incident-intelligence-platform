import assert from "node:assert/strict";
import { NotificationListener, type ListenConnection } from "./listener";

class FakeConnection implements ListenConnection {
  private notify: (payload: string) => void = () => undefined;
  private closeCallback: (error?: Error) => void = () => undefined;
  closed = false;
  onNotification(callback: (payload: string) => void): void {
    this.notify = callback;
  }
  onClose(callback: (error?: Error) => void): void {
    this.closeCallback = callback;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  push(payload: string): void {
    this.notify(payload);
  }
  drop(error?: Error): void {
    this.closeCallback(error);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function rig(script: Array<"ok" | "fail">) {
  const connections: FakeConnection[] = [];
  const received: string[] = [];
  let gaps = 0;
  let attempts = 0;
  const listener = new NotificationListener(
    async () => {
      attempts += 1;
      const step = script[Math.min(attempts - 1, script.length - 1)];
      if (step === "fail") throw new Error("refused");
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    { onNotification: (p) => void received.push(p), onGap: () => void (gaps += 1) },
    { minBackoffMs: 5, maxBackoffMs: 20 },
  );
  return { listener, connections, received, gaps: () => gaps, attempts: () => attempts };
}

describe("NotificationListener", () => {
  it("forwards notifications and reports no gap for a clean first connection", async () => {
    const r = rig(["ok"]);
    await r.listener.start();
    r.connections[0]?.push("a");
    r.connections[0]?.push("b");
    assert.deepEqual(r.received, ["a", "b"]);
    assert.equal(r.gaps(), 0);
    assert.equal(r.listener.connected, true);
    await r.listener.stop();
  });

  it("does not throw when the first connection fails, retries, and then reports a gap", async () => {
    const r = rig(["fail", "fail", "ok"]);
    await r.listener.start();
    assert.equal(r.listener.connected, false);
    await sleep(120);
    assert.equal(r.listener.connected, true);
    assert.equal(r.gaps(), 1, "clients that connected during the outage must be told to resync");
    await r.listener.stop();
  });

  it("reconnects after the connection drops and reports a gap once it is back", async () => {
    const r = rig(["ok", "ok"]);
    await r.listener.start();
    r.connections[0]?.drop(new Error("terminated"));
    assert.equal(r.listener.connected, false);
    await sleep(60);
    assert.equal(r.listener.connected, true);
    assert.equal(r.gaps(), 1);
    r.connections[1]?.push("after");
    assert.deepEqual(r.received, ["after"]);
    assert.equal(r.connections[0]?.closed, true, "the dead connection is released");
    await r.listener.stop();
  });

  it("keeps retrying with a bounded backoff while the database is down", async () => {
    const r = rig(["ok", "fail"]);
    await r.listener.start();
    r.connections[0]?.drop();
    await sleep(150);
    assert.ok(r.attempts() >= 4, `expected repeated attempts, saw ${r.attempts()}`);
    assert.equal(r.listener.connected, false);
    await r.listener.stop();
  });

  it("ignores a late close event from a connection that was already replaced", async () => {
    const r = rig(["ok", "ok"]);
    await r.listener.start();
    const first = r.connections[0] as FakeConnection;
    first.drop();
    await sleep(60);
    assert.equal(r.listener.connected, true);
    first.drop(new Error("late"));
    assert.equal(r.listener.connected, true);
    await r.listener.stop();
  });

  it("stop() closes the connection and cancels any pending retry", async () => {
    const r = rig(["ok", "ok"]);
    await r.listener.start();
    r.connections[0]?.drop();
    await r.listener.stop();
    const attemptsAtStop = r.attempts();
    await sleep(60);
    assert.equal(r.attempts(), attemptsAtStop);
    assert.equal(r.listener.connected, false);
  });

  it("closes a connection that finishes opening after stop()", async () => {
    let release!: () => void;
    const slow = new FakeConnection();
    const listener = new NotificationListener(
      () =>
        new Promise<ListenConnection>((resolve) => {
          release = () => resolve(slow);
        }),
      { onNotification: () => undefined, onGap: () => undefined },
    );
    const starting = listener.start();
    await listener.stop();
    release();
    await starting;
    assert.equal(slow.closed, true);
    assert.equal(listener.connected, false);
  });
});
