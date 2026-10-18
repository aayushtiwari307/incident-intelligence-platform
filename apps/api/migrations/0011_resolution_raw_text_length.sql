ALTER TABLE incident_resolutions
  ADD CONSTRAINT incident_resolutions_root_cause_raw_length
    CHECK (char_length(root_cause) <= 2000),
  ADD CONSTRAINT incident_resolutions_fix_applied_raw_length
    CHECK (char_length(fix_applied) <= 2000);
