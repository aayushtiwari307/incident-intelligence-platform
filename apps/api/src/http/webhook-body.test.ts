import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { AppError } from "../common/errors";
import { readJsonBody, type BodySource } from "./webhook-body";

function source(chunks: Array<string | Buffer>, headers: Record<string, string> = { "content-type": "application/json" }): BodySource & { destroyed: boolean } {
  const stream = Readable.from(chunks, { objectMode: false }) as unknown as BodySource & { destroyed: boolean };
  (stream as unknown as { headers: unknown }).headers = headers;
  return stream;
}

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected failure");
}

describe("webhook body reader", () => {
  it("parses JSON, including bodies split across chunks and a charset parameter", async () => {
    const body = await readJsonBody(source(['{"a":', "1,", '"b":[2]}'], { "content-type": "Application/JSON; charset=utf-8" }), { limitBytes: 1000 });
    assert.deepEqual(body, { a: 1, b: [2] });
  });

  it("rejects other content types and any content encoding with 415 (no decompression is attempted)", async () => {
    assert.equal((await failure(readJsonBody(source(["{}"], { "content-type": "text/plain" }), { limitBytes: 100 }))).status, 415);
    assert.equal((await failure(readJsonBody(source(["{}"], {}), { limitBytes: 100 }))).status, 415);
    assert.equal((await failure(readJsonBody(source(["{}"], { "content-type": "application/json", "content-encoding": "gzip" }), { limitBytes: 100 }))).status, 415);
  });

  it("rejects empty and invalid JSON with 400", async () => {
    assert.equal((await failure(readJsonBody(source([]), { limitBytes: 100 }))).status, 400);
    assert.equal((await failure(readJsonBody(source(["{not json"]), { limitBytes: 100 }))).status, 400);
  });

  it("413 from Content-Length without reading, with an actionable message and Connection: close", async () => {
    const e = await failure(readJsonBody(source(["{}"], { "content-type": "application/json", "content-length": "5000" }), { limitBytes: 1000 }));
    assert.equal(e.status, 413);
    assert.equal(e.code, "PAYLOAD_TOO_LARGE");
    assert.equal(e.headers?.Connection, "close");
    assert.match(e.message, /group_by/);
    assert.match(e.message, /WEBHOOK_BODY_LIMIT_BYTES/);
  });

  it("413 for a chunked body that grows past the limit, and is exact at the boundary", async () => {
    const e = await failure(readJsonBody(source(["[", "1,".repeat(300), "1]"]), { limitBytes: 500 }));
    assert.equal(e.status, 413);
    const exact = JSON.stringify({ k: "x".repeat(92) });
    assert.equal(exact.length, 100);
    assert.deepEqual(await readJsonBody(source([exact]), { limitBytes: 100 }), { k: "x".repeat(92) });
    assert.equal((await failure(readJsonBody(source([exact]), { limitBytes: 99 }))).status, 413);
  });

  it("stops draining an endless over-limit body (destroys the stream beyond 4x the limit)", async () => {
    const endless = Readable.from((function* () { for (;;) yield Buffer.alloc(1000, 0x20); })()) as unknown as BodySource & { destroyed: boolean };
    (endless as unknown as { headers: unknown }).headers = { "content-type": "application/json" };
    const e = await failure(readJsonBody(endless, { limitBytes: 1000 }));
    assert.equal(e.status, 413);
    assert.equal(endless.destroyed, true);
  });

  it("a stalled sender gets a retryable 503 instead of holding the connection", async () => {
    const stalled = new Readable({ read() { /* never produces data */ } }) as unknown as BodySource & { destroyed: boolean };
    (stalled as unknown as { headers: unknown }).headers = { "content-type": "application/json" };
    const e = await failure(readJsonBody(stalled, { limitBytes: 1000, timeoutMs: 50 }));
    assert.equal(e.status, 503);
    assert.ok(e.headers?.["Retry-After"]);
    assert.equal(stalled.destroyed, true);
  });
});
