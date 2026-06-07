/**
 * mail_app - Zero email-client app state, slimmed for self-hosted.
 *
 * What's here vs upstream Zero (`apps/email/server/src/db/schema.ts`):
 *
 *   KEEP (renamed `mail0_*` → bare names under `mail_app` schema)
 *     • user_settings       - per-user UI preferences (JSON)
 *     • user_hotkeys        - per-user keybindings (JSON)
 *     • summary             - AI summaries per message
 *     • note                - notes attached to threads
 *     • writing_style_matrix - AI compose-helper style
 *     • email_template      - saved email templates
 *
 *   DROP (existed for Gmail/Outlook OAuth - N/A in self-hosted)
 *     • user                - replaced by vmail.mailbox
 *     • session             - replaced by Dovecot/IMAP auth
 *     • account             - Better Auth OAuth account
 *     • connection          - per-Gmail/Outlook connection
 *     • verification        - email-verification flow (admin creates users)
 *     • earlyAccess         - N/A
 *     • jwks                - OAuth signing keys
 *     • oauthApplication / oauthAccessToken / oauthConsent
 *
 * Every kept table foreign-keys to `vmail.mailbox.username` - the canonical
 * user identity. `connection_id` references in upstream Zero (which point to
 * an OAuth connection row) are replaced by direct `username` references here.
 */

import {
  pgSchema,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  primaryKey,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { mailbox } from "./vmail";

export const mailAppSchema = pgSchema("mail_app");

// ─── user_settings ─────────────────────────────────────────────────────────

export const user_settings = mailAppSchema.table(
  "user_settings",
  {
    username: varchar("username", { length: 255 })
      .primaryKey()
      .references(() => mailbox.username, { onDelete: "cascade" }),
    settings: jsonb("settings").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
    updatedAt: timestamp("updated_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
  },
  (t) => [index("user_settings_settings_idx").on(t.settings)],
);

// ─── user_hotkeys ──────────────────────────────────────────────────────────

export const user_hotkeys = mailAppSchema.table(
  "user_hotkeys",
  {
    username: varchar("username", { length: 255 })
      .primaryKey()
      .references(() => mailbox.username, { onDelete: "cascade" }),
    shortcuts: jsonb("shortcuts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
    updatedAt: timestamp("updated_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
  },
  (t) => [index("user_hotkeys_shortcuts_idx").on(t.shortcuts)],
);

// ─── summary ───────────────────────────────────────────────────────────────
// AI-generated summary of a single message. `connection_id` upstream is
// replaced by `username` (the mailbox owner the message lives in).

export const summary = mailAppSchema.table(
  "summary",
  {
    messageId: text("message_id").primaryKey(),
    username: varchar("username", { length: 255 })
      .notNull()
      .references(() => mailbox.username, { onDelete: "cascade" }),
    content: text("content").notNull(),
    saved: boolean("saved").notNull().default(false),
    tags: text("tags"),
    suggestedReply: text("suggested_reply"),
    createdAt: timestamp("created_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
    updatedAt: timestamp("updated_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
  },
  (t) => [
    index("summary_username_idx").on(t.username),
    index("summary_username_saved_idx").on(t.username, t.saved),
    index("summary_saved_idx").on(t.saved),
  ],
);

// ─── note ──────────────────────────────────────────────────────────────────

export const note = mailAppSchema.table(
  "note",
  {
    id: text("id").primaryKey(),
    username: varchar("username", { length: 255 })
      .notNull()
      .references(() => mailbox.username, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    content: text("content").notNull(),
    color: text("color").notNull().default("default"),
    isPinned: boolean("is_pinned").default(false),
    order: integer("order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
    updatedAt: timestamp("updated_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
  },
  (t) => [
    index("note_username_idx").on(t.username),
    index("note_thread_id_idx").on(t.threadId),
    index("note_user_thread_idx").on(t.username, t.threadId),
    index("note_is_pinned_idx").on(t.isPinned),
  ],
);

// ─── writing_style_matrix ──────────────────────────────────────────────────

export const writing_style_matrix = mailAppSchema.table(
  "writing_style_matrix",
  {
    username: varchar("username", { length: 255 })
      .notNull()
      .references(() => mailbox.username, { onDelete: "cascade" }),
    numMessages: integer("num_messages").notNull(),
    style: jsonb("style").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
  },
  (t) => [
    primaryKey({ columns: [t.username] }),
    index("writing_style_matrix_style_idx").on(t.style),
  ],
);

// ─── email_template ────────────────────────────────────────────────────────

export const email_template = mailAppSchema.table(
  "email_template",
  {
    id: text("id").primaryKey(),
    username: varchar("username", { length: 255 })
      .notNull()
      .references(() => mailbox.username, { onDelete: "cascade" }),
    name: text("name").notNull(),
    subject: text("subject"),
    body: text("body"),
    to: jsonb("to"),
    cc: jsonb("cc"),
    createdAt: timestamp("created_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
    updatedAt: timestamp("updated_at", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`now()::timestamp without time zone`),
  },
  (t) => [index("email_template_username_idx").on(t.username)],
);

// ─── Type exports ──────────────────────────────────────────────────────────

export type UserSettings = typeof user_settings.$inferSelect;
export type UserHotkeys = typeof user_hotkeys.$inferSelect;
export type Summary = typeof summary.$inferSelect;
export type Note = typeof note.$inferSelect;
export type WritingStyleMatrix = typeof writing_style_matrix.$inferSelect;
export type EmailTemplate = typeof email_template.$inferSelect;
