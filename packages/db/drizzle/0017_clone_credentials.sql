-- Per-project clone-token override.
-- When set, resolveCloneToken returns this first (highest priority in the
-- chain). Encrypted via lib/encryption - never raw text. Nullable: most
-- projects fall back to the user-global token or the GitHub App install.
ALTER TABLE "project" ADD COLUMN "clone_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "clone_token_set_at" timestamp;--> statement-breakpoint

-- User-global clone token + the "use as default" toggle. The token sits in
-- user_settings encrypted; `as_default=true` means resolveCloneToken should
-- use it as the second tier after per-project overrides. When false the
-- token is stored but ignored (handy for projects-only opt-in).
ALTER TABLE "user_settings" ADD COLUMN "clone_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "clone_token_set_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "clone_token_as_default" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- First-time deploy nudge memory. "prompt" = ask the user once; "local" =
-- they chose build-locally; "remote-with-token" = they chose to ship a
-- token to the remote builder. After the first answer the nudge stops.
ALTER TABLE "user_settings" ADD COLUMN "clone_strategy_preference" text NOT NULL DEFAULT 'prompt';--> statement-breakpoint

-- Per-user gh-CLI suppression. In local/desktop mode the API silently falls
-- back to the machine's `gh auth token` if Openship's OAuth row is missing.
-- That's invisible - when the user clicks "Disconnect" they expect to BE
-- disconnected, not silently re-auth via gh. This flag lets the UI tell the
-- API "ignore gh CLI even if present"; flipped true on cli-source disconnect,
-- back to false when the user reconnects via gh.
ALTER TABLE "user_settings" ADD COLUMN "github_cli_disabled" boolean NOT NULL DEFAULT false;
