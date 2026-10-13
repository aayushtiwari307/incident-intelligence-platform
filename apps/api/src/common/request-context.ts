import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const currentRequestId = (): string | undefined => storage.getStore()?.requestId;

/** Always generates the id server-side: a client-supplied id would let callers forge log correlation. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);
  storage.run({ requestId }, () => next());
}
