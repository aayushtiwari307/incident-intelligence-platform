# 0001 Persistence: `pg`, handwritten SQL, thin repositories

**Decision.** Use `pg` directly. Schema changes are handwritten, numbered `.sql` files in `apps/api/migrations`, applied by our own runner (`apps/api/src/db/migrate`). Data access goes through small repository classes with parameterised queries.

**Why.** The goal is to demonstrate PostgreSQL directly (constraints, transactions, locking, deferred triggers). This is a deliberate choice, not a claim that an ORM cannot do custom SQL.

**Runner guarantees (each covered by an integration test against real PostgreSQL):**
- one transaction per migration; a failing migration leaves no partial schema and no history row
- session-level advisory lock (`pg_try_advisory_lock`, polled with a timeout) so concurrent instances never run migrations at the same time; `LOCK_TIMEOUT` instead of waiting forever
- sha256 checksum of the normalised file (CRLF/BOM-insensitive, so Git on Windows does not cause false drift); editing an applied migration is refused
- missing file, renamed file and out-of-order (new file numbered below an applied one) are refused before anything runs
- `check` mode verifies without creating or changing anything; startup uses it by default
- `-- migrate:no-transaction` (header comment only) for statements such as `CREATE INDEX CONCURRENTLY`. "Single statement" is decided by a small SQL lexer (`sql-statements.ts`) that understands comments, quoted strings, quoted identifiers and `$$`/`$tag$` bodies, so a stray `$` or a `;` inside a string cannot fool it; unterminated quotes are errors and `BEGIN ATOMIC` bodies are rejected as unsupported. Such a migration is not atomic with its history row, so the file must be idempotent.
- BEGIN/COMMIT/ROLLBACK inside a file are rejected because the runner owns the transaction
- one dedicated connection, not a pool, because advisory locks belong to a session

**Integrity lives in the database:** CHECK constraints, native `uuid`, normalised unique email, a deferred constraint trigger so every organization always has an owner, and the convention `UNIQUE (organization_id, id)` for composite foreign keys so a child row cannot reference a parent in another organization.

**Not verified here.** The `pg` adapter itself (`pg-adapter.ts`) has not been executed (the package could not be installed in the sandbox). The runner was exercised through a psql-backed session implementing the same interface. See the Phase 1 report.
