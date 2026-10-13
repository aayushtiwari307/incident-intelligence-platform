import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

export interface ScryptParams {
  /** CPU/memory cost, a power of two. */
  N: number;
  r: number;
  p: number;
}

/**
 * OWASP's scrypt guidance lists N=2^15, r=8, p=3 (about 32 MiB per hash) as an acceptable setting.
 * Built-in `crypto.scrypt` is used instead of bcrypt/argon2 so there is no native dependency to compile
 * on Windows and nothing new to add to the lockfile.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    // Node refuses to run when 128*N*r would exceed maxmem; leave headroom for p.
    maxmem: 256 * params.N * params.r * Math.max(1, params.p),
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Stored format: scrypt$N$r$p$<salt base64>$<hash base64>. The parameters travel with the hash so they can be raised later. */
export class PasswordHasher {
  private dummy?: Promise<string>;

  constructor(private readonly params: ScryptParams = DEFAULT_SCRYPT_PARAMS) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await derive(password, salt, this.params);
    const { N, r, p } = this.params;
    return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parseStored(stored);
    if (!parsed) return false;
    const key = await derive(password, parsed.salt, parsed.params);
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  }

  /** True when the stored hash was made with weaker parameters than the current ones. */
  needsRehash(stored: string): boolean {
    const parsed = parseStored(stored);
    if (!parsed) return true;
    const { N, r, p } = parsed.params;
    return N < this.params.N || r < this.params.r || p < this.params.p;
  }

  /**
   * Burns the same time as a real verification. Login calls this when the email is unknown so that response
   * time does not reveal which emails are registered.
   */
  async verifyDummy(password: string): Promise<false> {
    this.dummy ??= this.hash("dummy-password-for-constant-time-login");
    await this.verify(password, await this.dummy);
    return false;
  }
}

function parseStored(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Refuse absurd parameters from a corrupted or malicious row: they would be a denial-of-service lever.
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) {
    return undefined;
  }
  const salt = Buffer.from(parts[4] as string, "base64");
  const hash = Buffer.from(parts[5] as string, "base64");
  if (salt.length === 0 || hash.length !== KEY_LENGTH) return undefined;
  return { params: { N, r, p }, salt, hash };
}
