# 0009 The "every organization keeps an owner" rule under concurrency

**Finding.** The rule in `0001_foundation.sql` is a deferred constraint trigger evaluated at COMMIT. It is correct for any single
transaction and for transactions that commit one after the other. It is **not** safe against a write skew: with owners A and B,
transaction 1 demotes A and transaction 2 demotes B. Each check sees the *other* owner as still committed, both pass, both commit,
and the organization has **zero owners**. The transactions touch different rows, so row locks and unique constraints do not help.

**How it was reproduced (real PostgreSQL 16, two sessions).** Both transactions run the owner check (`SET CONSTRAINTS ALL IMMEDIATE`)
while the other change is uncommitted, then both commit:

| schema | txn 2 blocked behind txn 1 | txn 2 check | owners left |
|--------|---------------------------|-------------|-------------|
| 0001 + 0002 | no | passes | **0** |
| 0001 + 0002 + 0003 | yes | fails with 23514 | 1 |

**Correction to a first assumption.** A plain `COMMIT` of txn 2 *after* txn 1 has fully committed was already safe, because the
deferred check then sees the committed result. The unsafe window at plain COMMIT is only the short overlap of the two commit
sequences, which is hard to hit by accident and easy to hit when the check runs early (explicit `SET CONSTRAINTS ... IMMEDIATE`,
or any slow commit-time work). The test uses the widened schedule so the failure is deterministic rather than timing-dependent.

**Fix: `0003_serialize_owner_changes.sql`** (a new migration; `0001` is not edited because it may already be applied somewhere).
A `BEFORE UPDATE OR DELETE` row trigger on `memberships` takes `FOR NO KEY UPDATE` on the organization row whenever an owner is
removed, demoted, or moved to another organization. The lock lasts until the transaction ends, so a second owner-changing
transaction waits, then runs its own check against fresh data.
- `FOR NO KEY UPDATE`, not `FOR UPDATE`: ordinary membership inserts (which take `FOR KEY SHARE` on the organization) are not blocked.
- Per organization only: other organizations are not affected (tested).
- Deleting an organization or a user cascades into memberships and goes through the same trigger (tested for the user case).
- **Isolation level:** the check needs to see the other transaction's committed result, which only READ COMMITTED (the default)
  guarantees. Under REPEATABLE READ or SERIALIZABLE the trigger refuses to remove/demote an owner (`0A000`) instead of being
  silently unsafe. The application must not run owner changes at those levels.

**Tests** (`owner-concurrency.int.test.ts`, 8 cases, real PostgreSQL, two simultaneous sessions): write-skew schedule, concurrent
demote/demote, delete/delete, demote vs user deletion, legitimate hand-over racing a demotion, waiter proceeds after the first
rolls back, different organizations do not block each other, member inserts are not blocked, REPEATABLE READ refusal. Each test
waits until the second backend is really blocked on a lock (`pg_stat_activity`), so a missing lock fails loudly. With `0003`
removed, 7 of them fail; with only the lock statement deleted from `0003`, 5 fail.

**Not covered.** `TRUNCATE` bypasses row triggers (no application path truncates these tables). Direct superuser edits can disable
triggers. Application code should still use a short transaction and surface `23514` as "an organization needs at least one owner".
