-- 0014_service_change_context: service catalogue, tenant-bound change webhook and bounded incident correlation.

CREATE TABLE services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name            text NOT NULL,
  owner_team      text NOT NULL,
  tier            text NOT NULL DEFAULT 'tier3',
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT services_name_length CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  CONSTRAINT services_owner_team_length CHECK (char_length(owner_team) BETWEEN 1 AND 80 AND owner_team = btrim(owner_team)),
  CONSTRAINT services_tier_valid CHECK (tier IN ('tier1', 'tier2', 'tier3'))
);
CREATE UNIQUE INDEX services_org_name_key ON services (organization_id, lower(name));
CREATE INDEX services_org_created_idx ON services (organization_id, lower(name));

ALTER TABLE incidents ADD COLUMN service_id uuid;
ALTER TABLE incidents ADD CONSTRAINT incidents_service_fkey
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id) ON DELETE SET NULL (service_id);
CREATE INDEX incidents_org_service_idx ON incidents (organization_id, service_id, created_at DESC) WHERE service_id IS NOT NULL;

-- M10 uses a separate integration kind so an alertmanager credential cannot authenticate the change webhook.
ALTER TABLE integrations DROP CONSTRAINT integrations_kind_valid;
ALTER TABLE integrations ADD CONSTRAINT integrations_kind_valid CHECK (kind IN ('alertmanager', 'change-events'));

CREATE TABLE change_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  service_id      uuid NOT NULL,
  source          text NOT NULL,
  external_id     text NOT NULL,
  version         text NOT NULL,
  actor           text NOT NULL,
  changed_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT change_events_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT change_events_service_fkey FOREIGN KEY (organization_id, service_id)
    REFERENCES services (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT change_events_idempotency_key UNIQUE (organization_id, source, external_id),
  CONSTRAINT change_events_source_valid CHECK (source ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  CONSTRAINT change_events_external_id_valid CHECK (external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT change_events_version_length CHECK (char_length(version) BETWEEN 1 AND 100),
  CONSTRAINT change_events_actor_length CHECK (char_length(actor) BETWEEN 1 AND 120)
);
CREATE INDEX change_events_org_service_changed_idx ON change_events (organization_id, service_id, changed_at DESC, id);

-- This event is only a wake-up/audit pointer. The change details are fetched through the authenticated service context API.
ALTER TABLE incident_events DROP CONSTRAINT incident_events_type_valid;
ALTER TABLE incident_events ADD CONSTRAINT incident_events_type_valid CHECK (type IN
  ('created', 'status_changed', 'assigned', 'severity_changed', 'edited', 'comment', 'resolution_changed', 'change_context'));
