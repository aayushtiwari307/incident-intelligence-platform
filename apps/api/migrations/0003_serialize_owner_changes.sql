-- 0003_serialize_owner_changes: close a write-skew race in the "every organization keeps an owner" rule.
--
-- The problem (0001): the owner check runs as a deferred constraint trigger at COMMIT. Take an
-- organization with two owners, A and B. Transaction 1 demotes A, transaction 2 demotes B. Each
-- one's check at COMMIT still sees the OTHER owner as committed, so both pass, both commit, and the
-- organization ends up with no owner. Neither transaction touched the same row, so row locks and
-- unique constraints do not help.
--
-- The fix: any statement that removes or demotes an owner (or moves an owner to another
-- organization) first takes a row lock on that organization. The lock is held until the transaction
-- ends, so a second owner-changing transaction waits for the first to commit or roll back, and its
-- own COMMIT-time check then runs against fresh data and fails with 23514 if the rule would break.
--
-- FOR NO KEY UPDATE (not FOR UPDATE) so ordinary inserts into memberships, which only take
-- FOR KEY SHARE on the organization row for the foreign key, are not blocked.
--
-- Isolation level: the COMMIT-time check needs to see the other transaction's committed result,
-- which only READ COMMITTED (the PostgreSQL default) guarantees. Under REPEATABLE READ or
-- SERIALIZABLE the check would use an older snapshot, so owner changes are refused there instead
-- of silently being unsafe.

CREATE FUNCTION lock_organization_for_owner_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'owner'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.organization_id <> OLD.organization_id) THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'removing or demoting an owner requires READ COMMITTED isolation (current: %)',
        current_setting('transaction_isolation')
        USING ERRCODE = '0A000';
    END IF;
    -- No row if the organization is already being deleted by this transaction: nothing to protect then.
    PERFORM 1 FROM organizations WHERE id = OLD.organization_id FOR NO KEY UPDATE;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memberships_lock_org_on_owner_change
  BEFORE UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION lock_organization_for_owner_change();
