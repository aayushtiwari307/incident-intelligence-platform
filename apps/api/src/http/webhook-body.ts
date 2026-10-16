import { AppError, serviceUnavailable } from "../common/errors";

/** The part of an incoming request this reader needs; Express/Node's IncomingMessage satisfies it. */
export interface BodySource extends AsyncIterable<Buffer | Uint8Array | string> {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  destroy?(error?: Error): unknown;
}

export interface ReadJsonOptions {
  /** Maximum accepted body size in bytes. */
  limitBytes: number;
  /** The whole body must arrive within this time. A stalled sender gets a retryable failure instead of holding a connection. */
  timeoutMs?: number;
}

const header = (source: BodySource, name: string): string | undefined => {
  const value = source.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const tooLarge = (limitBytes: number): AppError =>
  new AppError(
    "PAYLOAD_TOO_LARGE",
    `The request body is larger than the ${limitBytes}-byte limit for this endpoint. Retrying the same request cannot succeed: send fewer alerts per notification ` +
      "(smaller Alertmanager groups via group_by) or raise WEBHOOK_BODY_LIMIT_BYTES; see docs/integrations/alertmanager.md.",
    { details: { limitBytes }, headers: { Connection: "close" } },
  );

/**
 * Reads and parses a JSON request body with a limit of its own (the webhook has a larger limit than the browser
 * endpoints, which keep the small global limit). Written by hand instead of using the framework parser so that EVERY
 * failure is mapped to this API's error shape with an actionable message, including the over-limit case:
 *   413 PAYLOAD_TOO_LARGE        over the limit (by Content-Length, or counted while streaming)
 *   415 UNSUPPORTED_MEDIA_TYPE   not application/json, or a Content-Encoding (no decompression is ever attempted)
 *   400 VALIDATION_FAILED        empty or invalid JSON
 *   503 SERVICE_UNAVAILABLE      the body did not arrive in time (retryable)
 * Over-limit bodies are drained (not buffered) up to 4x the limit so the 413 can still be delivered over a keep-alive
 * connection; beyond that the connection is destroyed.
 */
export async function readJsonBody(source: BodySource, { limitBytes, timeoutMs = 30_000 }: ReadJsonOptions): Promise<unknown> {
  const contentType = (header(source, "content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const encoding = (header(source, "content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity") throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Compressed request bodies are not supported");

  const declared = header(source, "content-length");
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limitBytes) throw tooLarge(limitBytes);

  const drainCeiling = limitBytes * 4;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      source.destroy?.();
      reject(serviceUnavailable(5, "The request body did not arrive in time; retry"));
    }, timeoutMs);
  });

  const read = async (): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;
    for await (const chunk of source) {
      const piece = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      total += piece.length;
      if (exceeded) {
        if (total > drainCeiling) {
          source.destroy?.();
          break;
        }
        continue;
      }
      if (total > limitBytes) {
        exceeded = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(piece);
    }
    if (exceeded) throw tooLarge(limitBytes);
    return Buffer.concat(chunks);
  };

  try {
    const body = await Promise.race([read(), timedOut]);
    if (body.length === 0) throw new AppError("VALIDATION_FAILED", "The request body is empty", { details: [{ path: "", message: "a JSON body is required" }] });
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", "The request body is not valid JSON", { details: [{ path: "", message: "invalid JSON" }] });
    }
  } finally {
    clearTimeout(timer);
    timedOut.catch(() => undefined); // a late rejection after a successful read must not become an unhandled rejection
  }
}
