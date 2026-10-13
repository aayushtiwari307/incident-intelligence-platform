-- 0001_foundation: organizations, users, memberships.
--
-- Integrity rules live in the database, not only in application code:
--   * identifiers are native uuid, formats and lengths are CHECK constraints
--   * email is stored normalised (lowercase, trimmed) and unique
--   * a membership role must be one of the four known roles
--   * every organization must always have at least one owner (deferred constraint trigger,
--     checked at COMMIT so that "create org + first owner" works in one transaction)
--
-- Tenant-safety convention for later tables: every tenant-owned table carries organization_id
-- and a UNIQUE (organization_id, id) so that children can use composite foreign keys such as
-- FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id).
-- That makes it impossible for a row to point at a parent in a different organization.

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

CREATE TABLE organizations (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text        NOT NULL,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_key UNIQUE (slug),
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  CONSTRAINT organizations_name_length CHECK (char_length(name) BETWEEN 1 AND 120)
);

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  display_name  text        NOT NULL,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_normalised CHECK (
    email = lower(btrim(email))
    AND char_length(email) BETWEEN 3 AND 254
    AND position('@' IN email) > 1
  ),
  CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 80),
  CONSTRAINT users_password_hash_length CHECK (char_length(password_hash) BETWEEN 20 AND 255)
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memberships (
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT memberships_role_valid CHECK (role IN ('viewer', 'responder', 'admin', 'owner'))
);

CREATE INDEX memberships_user_id_idx ON memberships (user_id);

-- Every existing organization must keep at least one owner.
CREATE FUNCTION organization_lacks_owner(org_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM organizations o WHERE o.id = org_id)
     AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = org_id AND m.role = 'owner')
$$;

CREATE FUNCTION assert_organization_has_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'organizations' THEN
    IF organization_lacks_owner(NEW.id) THEN
      RAISE EXCEPTION 'organization % must have at least one owner', NEW.id USING ERRCODE = '23514';
    END IF;
  ELSE
    IF TG_OP IN ('UPDATE', 'DELETE') AND organization_lacks_owner(OLD.organization_id) THEN
      RAISE EXCEPTION 'organization % must have at least one owner', OLD.organization_id USING ERRCODE = '23514';
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND organization_lacks_owner(NEW.organization_id) THEN
      RAISE EXCEPTION 'organization % must have at least one owner', NEW.organization_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER organizations_require_owner
  AFTER INSERT ON organizations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_organization_has_owner();

CREATE CONSTRAINT TRIGGER memberships_require_owner
  AFTER UPDATE OR DELETE ON memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_organization_has_owner();
