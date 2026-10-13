/** One dedicated database connection. The advisory lock is session-scoped, so the runner must keep using the same one. */
export interface MigrationSession {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

export type ConnectSession = () => Promise<MigrationSession>;

export type MigrationErrorCode =
  | "INVALID_FILENAME"
  | "DUPLICATE_VERSION"
  | "INVALID_CONTENT"
  | "LOCK_TIMEOUT"
  | "CHECKSUM_MISMATCH"
  | "MISSING_FILE"
  | "NAME_MISMATCH"
  | "OUT_OF_ORDER"
  | "PENDING_MIGRATIONS"
  | "MIGRATION_FAILED";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
  }
}

export interface MigrationFile {
  /** Four-digit prefix, e.g. "0001". Applied in ascending order. */
  version: string;
  /** File name without version prefix and extension, e.g. "foundation". */
  name: string;
  filename: string;
  sql: string;
  /** sha256 of the normalised content (LF line endings, no BOM). */
  checksum: string;
  /** Declared with `-- migrate:no-transaction`; must be a single statement. */
  transactional: boolean;
}
