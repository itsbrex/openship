-- Mail-server setup session - persisted state of the iRedMail provisioning
-- wizard. One row per (server_id, domain) so retries against the same target
-- resume the same session, while switching server/domain creates a fresh row.
CREATE TABLE IF NOT EXISTS "mail_setup_session" (
    "id" text PRIMARY KEY,
    "server_id" text NOT NULL,
    "domain" text NOT NULL,
    "running" boolean NOT NULL DEFAULT false,
    "cancelled" boolean NOT NULL DEFAULT false,
    "current_step" integer NOT NULL DEFAULT 1,
    "resume_step" integer,
    "error_message" text,
    "completed_steps" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "logs" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "dns_records" jsonb,
    "dns_acknowledged" boolean NOT NULL DEFAULT false,
    "secrets" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "started_at" timestamp NOT NULL DEFAULT now(),
    "finished_at" timestamp,
    "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Upsert lookup key - the controller treats (server_id, domain) as the
-- session's natural identity. Index also accelerates the "active session"
-- query (`WHERE running = true`).
CREATE UNIQUE INDEX IF NOT EXISTS "mail_setup_session_server_domain_idx"
    ON "mail_setup_session" ("server_id", "domain");
