-- Rollback / retention columns on deployment. Owned exclusively by
-- the RollbackOrchestrator (apps/api/src/modules/deployments/rollback/).
--
-- artifact_retained_at — set when the orchestrator archives the artifact
-- (preserves it in non-active state). Nulled when the orchestrator purges
-- the artifact. The dashboard reads this as "is this deployment still
-- rollbackable?".
--
-- pinned — user-tagged keep-rollbackable-indefinitely. Pinned deployments
-- are exempt from prune. Hard-capped via instance_settings.

ALTER TABLE "deployment"
  ADD COLUMN "artifact_retained_at" timestamp;
--> statement-breakpoint
ALTER TABLE "deployment"
  ADD COLUMN "pinned" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Backfill existing 'ready' rows so they show as rollbackable in the UI.
-- The orchestrator will own the column going forward (set on success,
-- null on prune).
UPDATE "deployment"
  SET "artifact_retained_at" = "created_at"
  WHERE "status" = 'ready' AND "artifact_retained_at" IS NULL;
