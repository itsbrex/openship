-- Drop mail_setup_session - replaced by on-VPS state file at
-- /root/.openship-mail-state.json. State about what's installed on a
-- specific server belongs WITH that server: purge the VPS, the file
-- goes with it, no stale row in openship's DB to confuse the next install.
--
-- IF EXISTS handles installs that never ran 0013 (the table never existed).
-- Idempotent - re-running this migration is a no-op.
DROP TABLE IF EXISTS "mail_setup_session";
