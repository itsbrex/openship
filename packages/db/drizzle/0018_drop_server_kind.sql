-- Collapse the server "kind" distinction. Mail provisioning is detected at
-- runtime from the per-host mail-state.json the install pipeline writes -
-- no schema-level role flag, no New-Server-wizard picker. A server is just
-- a server; the /emails page handles mail-server detection and management
-- on its own page, not as a tab on the server detail.
ALTER TABLE "servers" DROP COLUMN IF EXISTS "runs_apps";--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN IF EXISTS "runs_mail";
