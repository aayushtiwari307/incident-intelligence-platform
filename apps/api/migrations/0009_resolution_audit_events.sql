-- Resolution audit events record prior and new field values within the existing payload size limit.
ALTER TABLE incident_events
  DROP CONSTRAINT incident_events_type_valid,
  ADD CONSTRAINT incident_events_type_valid CHECK (type IN
    ('created', 'status_changed', 'assigned', 'severity_changed', 'edited', 'comment', 'resolution_changed')),
  DROP CONSTRAINT incident_events_payload_size,
  ADD CONSTRAINT incident_events_payload_size CHECK (pg_column_size(payload) <= 65536);
