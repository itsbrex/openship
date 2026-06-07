import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

// ─── Instance Settings ───────────────────────────────────────────────────────

/**
 * Machine-level configuration for this Openship installation.
 *
 * Single row - not per-user. Set by the desktop app (or installer) during
 * onboarding via the internal API.
 *
 * SSH server config lives in the `servers` table (single source of truth).
 * This table only stores instance-level preferences: auth strategy,
 * tunnel provider, and default build mode.
 */
export const instanceSettings = pgTable("instance_settings", {
  id: text("id").primaryKey().default("default"), // single row

  // ── Tunnel / connectivity ──────────────────────────────────────────────────

  /**
   * Tunnel provider:
   *   "edge"       → Openship Edge (zero-config, managed)
   *   "cloudflare" → Cloudflare Tunnel (user's account)
   *   "ngrok"      → ngrok tunnel
   *   null         → public IP, no tunnel needed
   */
  tunnelProvider: text("tunnel_provider"),
  tunnelToken: text("tunnel_token"),

  // ── Auth / mode ─────────────────────────────────────────────────────────────

  /**
   * Auth strategy for this instance:
   *   "none"  → zero-auth, auto-provisioned local user (desktop default)
   *   "cloud" → external auth on Openship Cloud (desktop + cloud)
   *   "local" → local Better Auth (self-hosted / SaaS)
   */
  authMode: text("auth_mode").notNull().default("none"),

  // ── Defaults ───────────────────────────────────────────────────────────────

  /** Default build mode for new users on this instance */
  defaultBuildMode: text("default_build_mode").notNull().default("auto"),
  /** Default number of previous successful bare releases to retain for rollback */
  defaultRollbackWindow: integer("default_rollback_window").notNull().default(5),

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── User Platform Settings ──────────────────────────────────────────────────

/**
 * Per-user platform preferences - syncs across devices & to Openship Cloud.
 *
 * Each user gets one row (1:1 with `user`).
 * Build mode defaults to the instance default if not set.
 */
export const userSettings = pgTable("user_settings", {
  id: text("id").primaryKey(), // "us_..."
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),

  /**
   * Per-user build strategy override:
   *   "auto"   → use the stack's defaultBuildStrategy (smart per-framework)
   *   "server" → always build on the server
   *   "local"  → always build locally, transfer the output
   */
  buildMode: text("build_mode").notNull().default("auto"),

  /**
   * Encrypted session token for the user's Openship Cloud account.
   * Used by local instances to fetch namespace tokens from api.openship.io.
   * Null if the user hasn't linked their cloud account.
   */
  cloudSessionToken: text("cloud_session_token"),

  /**
   * Default deploy target seeded into new deployments:
   *   "local"  → this machine
   *   "server" → a configured server (pair with `defaultServerId`)
   *   "cloud"  → Openship Cloud
   *   null     → no preference, the deploy picker chooses (auto-selected
   *              when only one target is available)
   * The user can always override per-deployment from the picker on /deploy.
   */
  defaultDeployTarget: text("default_deploy_target"),

  /**
   * When defaultDeployTarget="server", the specific server to preselect.
   * Stored as a free-form text id (not FK) so that the row survives a
   * server deletion - the deploy picker just falls back to "no default"
   * when the id no longer resolves.
   */
  defaultServerId: text("default_server_id"),

  /* ── Clone credentials ────────────────────────────────────────────────────
   * User-level GitHub clone token (encrypted). The clone module reads this
   * AFTER per-project override and BEFORE the GitHub App installation token,
   * but only when `cloneTokenAsDefault === true`. Users set this in Settings
   * to keep a single PAT for everything.
   */
  cloneTokenEncrypted: text("clone_token_encrypted"),
  cloneTokenSetAt: timestamp("clone_token_set_at"),
  cloneTokenAsDefault: boolean("clone_token_as_default").notNull().default(false),

  /**
   * What the first-time deploy nudge resolved to. Once set to anything other
   * than "prompt", the nudge stops asking.
   *   "prompt"            → first deploy will show the picker
   *   "local"             → silently default unsafe combos to local build
   *   "remote-with-token" → user accepted the trade-off, ship token to remote
   */
  cloneStrategyPreference: text("clone_strategy_preference").notNull().default("prompt"),

  /**
   * Local-mode gh-CLI suppression. In `cli` auth mode the API falls back to
   * the host's `gh auth token` when no OAuth row is stored. That makes
   * Disconnect feel broken because gh silently re-authenticates. When this
   * flag is true the API treats gh CLI as if it isn't installed.
   */
  githubCliDisabled: boolean("github_cli_disabled").notNull().default(false),

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
