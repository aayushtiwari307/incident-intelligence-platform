ALTER TABLE incident_resolutions
  DROP CONSTRAINT incident_resolutions_root_cause_length,
  ADD CONSTRAINT incident_resolutions_root_cause_length
    CHECK (char_length(btrim(root_cause)) BETWEEN 1 AND 2000 AND root_cause ~ '[^[:space:]]'),
  DROP CONSTRAINT incident_resolutions_fix_applied_length,
  ADD CONSTRAINT incident_resolutions_fix_applied_length
    CHECK (char_length(btrim(fix_applied)) BETWEEN 1 AND 2000 AND fix_applied ~ '[^[:space:]]');
