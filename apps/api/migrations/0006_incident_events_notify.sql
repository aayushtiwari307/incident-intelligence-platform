-- 0006_incident_events_notify: tell listening API instances that a timeline entry was committed.
--
-- pg_notify inside a transaction is queued and delivered only if (and when) the transaction COMMITS, in commit order,
-- so a rolled-back change never produces a push and a committed one always does. The payload is only the new entry's
-- id and organization (never incident content); the API loads the entry itself, filtered by that organization.
--
-- Doing this in a trigger (instead of in application code) means EVERY path that appends to the timeline
-- (including member removal, which unassigns incidents with raw SQL) is covered, now and in future.
-- Notifications are a wake-up signal, not a log: the append-only incident_events table stays the source of truth,
-- and clients recover from any missed notification by re-reading state over the authenticated REST API.

CREATE FUNCTION incident_events_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('incident_events', json_build_object('id', NEW.id, 'o', NEW.organization_id)::text);
  RETURN NULL;
END
$$;

CREATE TRIGGER incident_events_notify
  AFTER INSERT ON incident_events
  FOR EACH ROW EXECUTE FUNCTION incident_events_notify();
