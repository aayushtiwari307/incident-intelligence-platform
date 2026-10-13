import { createHash, randomBytes } from "node:crypto";

/** 256 bits from the OS CSPRNG, URL-safe. This is what the browser holds (session cookie, invite link). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Only this hash is stored. A plain SHA-256 is appropriate here, unlike for passwords: the input already has
 * 256 bits of entropy, so there is nothing to brute-force, and lookups by hash stay a cheap indexed equality.
 * A database leak therefore does not hand out usable sessions or invites.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
