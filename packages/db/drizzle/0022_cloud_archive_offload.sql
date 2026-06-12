-- Cloud archive strategy — per-project knob for how rollback artifacts
-- are preserved when a Cloud deployment leaves the active slot.
--
--   'inplace' (default, only one currently implemented)
--       CloudRuntime calls Oblien `snapshots.createArchive` then
--       `workspace.stop`. The workspace stays in Oblien (compute
--       paused, disk + archive preserved). Rollback just starts it
--       back up. Purge deletes the workspace + its archives.
--
--   'offload' (reserved for future self-hosted use)
--       Streams disk to an external S3-compatible store. Not wired
--       on api.openship.io — Openship Cloud uses Oblien-native
--       archives end-to-end.
--
-- Bare/Docker runtimes ignore this column.

ALTER TABLE "project"
  ADD COLUMN "cloud_archive_strategy" text NOT NULL DEFAULT 'inplace';
