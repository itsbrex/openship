-- Server capabilities: replace the single `role` enum with two orthogonal
-- boolean flags. Composes cleanly for any combination - apps-only,
-- mail-only, or both on the same host (small self-hosted setups).
--
-- DROP COLUMN IF EXISTS handles installs that never ran 0011 OR ran it
-- and ended up with the `role` column. Both paths converge to the same
-- final shape: two booleans + no role column.
ALTER TABLE "servers" DROP COLUMN IF EXISTS "role";--> statement-breakpoint

-- Existing rows are interpreted as "runs apps, not mail" - matches the
-- historical default before mail-server support landed.
ALTER TABLE "servers" ADD COLUMN "runs_apps" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "runs_mail" boolean NOT NULL DEFAULT false;
