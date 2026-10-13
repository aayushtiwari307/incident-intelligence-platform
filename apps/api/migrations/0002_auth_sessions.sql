-- 0002_auth_sessions: server-side session records.
--
-- A stateless JWT cannot be revoked, so "log out" would only delete the token in the browser.
-- Each access token carries a session id (jti) that references a row here; logout and
-- "disable user" set revoked_at / disabled_at and the token stops working immediately.

CREATE TABLE auth_sessions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT auth_sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT auth_sessions_revoked_after_creation CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- Lookup of a user's live sessions (e.g. revoke all on password change).
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- Periodic cleanup of expired rows.
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions (expires_at);
