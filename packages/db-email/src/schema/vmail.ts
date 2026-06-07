/**
 * vmail - byte-faithful port of iRedMail's PostgreSQL schema.
 *
 * Source of truth: `apps/email/engine/samples/iredmail/iredmail.pgsql`
 * (do not edit that file; this is the Drizzle mirror).
 *
 * Why faithful:
 *   Postfix and Dovecot's iRedMail-shipped SQL config files
 *   (`apps/email/engine/samples/postfix/pgsql/*.cf`,
 *    `apps/email/engine/samples/dovecot/dovecot-sql.conf`)
 *   run literal SQL against these exact table + column names. Renaming
 *   anything here silently breaks a protocol - the daemon's query returns
 *   zero rows, auth fails, mail bounces. So every identifier is preserved
 *   from upstream.
 *
 * Tables (16):
 *   admin, alias, moderators, maillist_owners, forwardings, domain,
 *   alias_domain, domain_admins, mailbox, maillists, sender_bcc_domain,
 *   sender_bcc_user, recipient_bcc_domain, recipient_bcc_user,
 *   sender_relayhost, deleted_mailboxes, share_folder, anyone_shares,
 *   last_login, used_quota
 */

import {
  pgSchema,
  bigint,
  char,
  date,
  index,
  integer,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const vmailSchema = pgSchema("vmail");

// ─── Reusable column factories ─────────────────────────────────────────────

/** TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()::TIMESTAMP WITHOUT TIME ZONE */
const tsNow = (name: string) =>
  timestamp(name, { withTimezone: false, mode: "date" })
    .notNull()
    .default(sql`now()::timestamp without time zone`);

/** TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT '9999-12-31 01:01:01' (the iRedMail "never expires" sentinel) */
const tsNeverExpires = (name: string) =>
  timestamp(name, { withTimezone: false, mode: "date" })
    .notNull()
    .default(sql`'9999-12-31 01:01:01'`);

/** INT2 NOT NULL DEFAULT 1 - the iRedMail "active" / "enabled" flag pattern */
const activeFlag = (name: string, defaultValue: 0 | 1 = 1) =>
  smallint(name).notNull().default(defaultValue);

// ─── admin ─────────────────────────────────────────────────────────────────

export const admin = vmailSchema.table(
  "admin",
  {
    username: varchar("username", { length: 255 }).notNull().default(""),
    password: varchar("password", { length: 255 }).notNull().default(""),
    name: varchar("name", { length: 255 }).notNull().default(""),
    language: varchar("language", { length: 5 }).notNull().default(""),
    passwordlastchange: tsNow("passwordlastchange"),
    settings: text("settings").notNull().default(""),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.username] }),
    index("idx_admin_passwordlastchange").on(t.passwordlastchange),
    index("idx_admin_expired").on(t.expired),
    index("idx_admin_active").on(t.active),
  ],
);

// ─── alias ─────────────────────────────────────────────────────────────────

export const alias = vmailSchema.table(
  "alias",
  {
    address: varchar("address", { length: 255 }).notNull().default(""),
    name: varchar("name", { length: 255 }).notNull().default(""),
    accesspolicy: varchar("accesspolicy", { length: 30 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.address] }),
    index("idx_alias_domain").on(t.domain),
    index("idx_alias_expired").on(t.expired),
    index("idx_alias_active").on(t.active),
  ],
);

// ─── moderators ────────────────────────────────────────────────────────────

export const moderators = vmailSchema.table(
  "moderators",
  {
    id: serial("id").primaryKey(),
    address: varchar("address", { length: 255 }).notNull().default(""),
    moderator: varchar("moderator", { length: 255 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    dest_domain: varchar("dest_domain", { length: 255 }).notNull().default(""),
  },
  (t) => [
    index("idx_moderators_address").on(t.address),
    index("idx_moderators_moderator").on(t.moderator),
    uniqueIndex("idx_moderators_address_moderator").on(t.address, t.moderator),
    index("idx_moderators_domain").on(t.domain),
    index("idx_moderators_dest_domain").on(t.dest_domain),
  ],
);

// ─── maillist_owners ───────────────────────────────────────────────────────

export const maillist_owners = vmailSchema.table(
  "maillist_owners",
  {
    id: serial("id").primaryKey(),
    address: varchar("address", { length: 255 }).notNull().default(""),
    owner: varchar("owner", { length: 255 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    dest_domain: varchar("dest_domain", { length: 255 }).notNull().default(""),
  },
  (t) => [
    uniqueIndex("idx_maillist_owners_address_owner").on(t.address, t.owner),
    index("idx_maillist_owners_owner").on(t.owner),
    index("idx_maillist_owners_domain").on(t.domain),
    index("idx_maillist_owners_dest_domain").on(t.dest_domain),
  ],
);

// ─── forwardings ───────────────────────────────────────────────────────────
// Unified table for: mail-alias members, per-account aliases, per-user forwards.

export const forwardings = vmailSchema.table(
  "forwardings",
  {
    id: serial("id").primaryKey(),
    address: varchar("address", { length: 255 }).notNull().default(""),
    forwarding: varchar("forwarding", { length: 255 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    dest_domain: varchar("dest_domain", { length: 255 }).notNull().default(""),
    is_maillist: activeFlag("is_maillist", 0),
    is_list: activeFlag("is_list", 0),
    is_forwarding: activeFlag("is_forwarding", 0),
    is_alias: activeFlag("is_alias", 0),
    active: activeFlag("active"),
  },
  (t) => [
    index("idx_forwardings_address").on(t.address),
    index("idx_forwardings_forwarding").on(t.forwarding),
    uniqueIndex("idx_forwardings_address_forwarding").on(t.address, t.forwarding),
    index("idx_forwardings_domain").on(t.domain),
    index("idx_forwardings_dest_domain").on(t.dest_domain),
    index("idx_forwardings_is_maillist").on(t.is_maillist),
    index("idx_forwardings_is_list").on(t.is_list),
    index("idx_forwardings_is_forwarding").on(t.is_forwarding),
    index("idx_forwardings_is_alias").on(t.is_alias),
  ],
);

// ─── domain ────────────────────────────────────────────────────────────────

export const domain = vmailSchema.table(
  "domain",
  {
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    description: text("description").notNull().default(""),
    disclaimer: text("disclaimer").notNull().default(""),
    aliases: bigint("aliases", { mode: "number" }).notNull().default(0),
    mailboxes: bigint("mailboxes", { mode: "number" }).notNull().default(0),
    maillists: bigint("maillists", { mode: "number" }).notNull().default(0),
    maxquota: bigint("maxquota", { mode: "number" }).notNull().default(0),
    quota: bigint("quota", { mode: "number" }).notNull().default(0),
    transport: varchar("transport", { length: 255 }).notNull().default("dovecot"),
    settings: text("settings").notNull().default(""),
    backupmx: activeFlag("backupmx", 0),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.domain] }),
    index("idx_domain_backupmx").on(t.backupmx),
    index("idx_domain_expired").on(t.expired),
    index("idx_domain_active").on(t.active),
  ],
);

// ─── alias_domain ──────────────────────────────────────────────────────────

export const alias_domain = vmailSchema.table(
  "alias_domain",
  {
    alias_domain: varchar("alias_domain", { length: 255 }).notNull(),
    target_domain: varchar("target_domain", { length: 255 }).notNull(),
    created: tsNow("created"),
    modified: tsNow("modified"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.alias_domain] }),
    index("idx_alias_domain_target_domain").on(t.target_domain),
    index("idx_alias_domain_active").on(t.active),
  ],
);

// ─── domain_admins ─────────────────────────────────────────────────────────

export const domain_admins = vmailSchema.table(
  "domain_admins",
  {
    username: varchar("username", { length: 255 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.username, t.domain] }),
    index("idx_domain_admins_username").on(t.username),
    index("idx_domain_admins_domain").on(t.domain),
    index("idx_domain_admins_active").on(t.active),
  ],
);

// ─── mailbox ───────────────────────────────────────────────────────────────
// The core table. 50+ columns. Three of them carry hyphens in their SQL names
// (`enablelib-storage`, `enablequota-status`, `enableindexer-worker`) and must
// stay that way - Dovecot's dovecot-sql.conf references them verbatim. We pass
// the literal SQL name as the first arg to smallint() and quote them in the
// produced DDL.

export const mailbox = vmailSchema.table(
  "mailbox",
  {
    username: varchar("username", { length: 255 }).notNull(),
    password: varchar("password", { length: 255 }).notNull().default(""),
    name: varchar("name", { length: 255 }).notNull().default(""),
    language: varchar("language", { length: 5 }).notNull().default(""),
    first_name: varchar("first_name", { length: 255 }).notNull().default(""),
    last_name: varchar("last_name", { length: 255 }).notNull().default(""),
    mobile: varchar("mobile", { length: 255 }).notNull().default(""),
    telephone: varchar("telephone", { length: 255 }).notNull().default(""),
    recovery_email: varchar("recovery_email", { length: 255 }).notNull().default(""),
    birthday: date("birthday", { mode: "string" }).notNull().default("0001-01-01"),
    mailboxformat: varchar("mailboxformat", { length: 50 }).notNull().default("maildir"),
    mailboxfolder: varchar("mailboxfolder", { length: 50 }).notNull().default("Maildir"),
    storagebasedirectory: varchar("storagebasedirectory", { length: 255 }).notNull().default(""),
    storagenode: varchar("storagenode", { length: 255 }).notNull().default(""),
    maildir: varchar("maildir", { length: 255 }).notNull().default(""),
    quota: bigint("quota", { mode: "number" }).notNull().default(0),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    transport: varchar("transport", { length: 255 }).notNull().default(""),
    department: varchar("department", { length: 255 }).notNull().default(""),
    rank: varchar("rank", { length: 255 }).notNull().default("normal"),
    employeeid: varchar("employeeid", { length: 255 }).notNull().default(""),
    isadmin: activeFlag("isadmin", 0),
    isglobaladmin: activeFlag("isglobaladmin", 0),
    enablesmtp: activeFlag("enablesmtp"),
    enablesmtpsecured: activeFlag("enablesmtpsecured"),
    enablepop3: activeFlag("enablepop3"),
    enablepop3secured: activeFlag("enablepop3secured"),
    enablepop3tls: activeFlag("enablepop3tls"),
    enableimap: activeFlag("enableimap"),
    enableimapsecured: activeFlag("enableimapsecured"),
    enableimaptls: activeFlag("enableimaptls"),
    enabledeliver: activeFlag("enabledeliver"),
    enablelda: activeFlag("enablelda"),
    enablemanagesieve: activeFlag("enablemanagesieve"),
    enablemanagesievesecured: activeFlag("enablemanagesievesecured"),
    enablesieve: activeFlag("enablesieve"),
    enablesievesecured: activeFlag("enablesievesecured"),
    enablesievetls: activeFlag("enablesievetls"),
    enableinternal: activeFlag("enableinternal"),
    enabledoveadm: activeFlag("enabledoveadm"),
    // Hyphenated column names - Drizzle preserves these verbatim in DDL.
    enablelib_storage: activeFlag("enablelib-storage"),
    enablequota_status: activeFlag("enablequota-status"),
    enableindexer_worker: activeFlag("enableindexer-worker"),
    enablelmtp: activeFlag("enablelmtp"),
    enabledsync: activeFlag("enabledsync"),
    enablesogo: activeFlag("enablesogo"),
    // SOGo per-feature toggles are *character* flags ('y' / 'n'), NOT smallints.
    enablesogowebmail: varchar("enablesogowebmail", { length: 1 }).notNull().default("y"),
    enablesogocalendar: varchar("enablesogocalendar", { length: 1 }).notNull().default("y"),
    enablesogoactivesync: varchar("enablesogoactivesync", { length: 1 }).notNull().default("y"),
    allow_nets: text("allow_nets"),
    disclaimer: text("disclaimer").notNull().default(""),
    settings: text("settings").notNull().default(""),
    passwordlastchange: tsNow("passwordlastchange"),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.username] }),
    index("idx_mailbox_domain").on(t.domain),
    index("idx_mailbox_department").on(t.department),
    index("idx_mailbox_employeeid").on(t.employeeid),
    index("idx_mailbox_isadmin").on(t.isadmin),
    index("idx_mailbox_isglobaladmin").on(t.isglobaladmin),
    index("idx_mailbox_enablesmtp").on(t.enablesmtp),
    index("idx_mailbox_enablesmtpsecured").on(t.enablesmtpsecured),
    index("idx_mailbox_enablepop3").on(t.enablepop3),
    index("idx_mailbox_enablepop3secured").on(t.enablepop3secured),
    index("idx_mailbox_enableimap").on(t.enableimap),
    index("idx_mailbox_enableimapsecured").on(t.enableimapsecured),
    index("idx_mailbox_enableimaptls").on(t.enableimaptls),
    index("idx_mailbox_enablepop3tls").on(t.enablepop3tls),
    index("idx_mailbox_enablesievetls").on(t.enablesievetls),
    index("idx_mailbox_enabledeliver").on(t.enabledeliver),
    index("idx_mailbox_enablelda").on(t.enablelda),
    index("idx_mailbox_enablemanagesieve").on(t.enablemanagesieve),
    index("idx_mailbox_enablemanagesievesecured").on(t.enablemanagesievesecured),
    index("idx_mailbox_enablesieve").on(t.enablesieve),
    index("idx_mailbox_enablesievesecured").on(t.enablesievesecured),
    index("idx_mailbox_enablelmtp").on(t.enablelmtp),
    index("idx_mailbox_enabledsync").on(t.enabledsync),
    index("idx_mailbox_enableinternal").on(t.enableinternal),
    index("idx_mailbox_enabledoveadm").on(t.enabledoveadm),
    index("idx_mailbox_enablelib_storage").on(t.enablelib_storage),
    index("idx_mailbox_enablequota_status").on(t.enablequota_status),
    index("idx_mailbox_enableindexer_worker").on(t.enableindexer_worker),
    index("idx_mailbox_enablesogo").on(t.enablesogo),
    index("idx_mailbox_passwordlastchange").on(t.passwordlastchange),
    index("idx_mailbox_expired").on(t.expired),
    index("idx_mailbox_active").on(t.active),
  ],
);

// ─── maillists ─────────────────────────────────────────────────────────────

export const maillists = vmailSchema.table(
  "maillists",
  {
    id: serial("id").primaryKey(),
    address: varchar("address", { length: 255 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    transport: varchar("transport", { length: 255 }).notNull().default(""),
    accesspolicy: varchar("accesspolicy", { length: 30 }).notNull().default(""),
    maxmsgsize: bigint("maxmsgsize", { mode: "number" }).notNull().default(0),
    name: varchar("name", { length: 255 }).notNull().default(""),
    description: text("description"),
    mlid: varchar("mlid", { length: 36 }).notNull().default(""),
    is_newsletter: activeFlag("is_newsletter", 0),
    settings: text("settings"),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    uniqueIndex("idx_maillists_address").on(t.address),
    index("idx_maillists_domain").on(t.domain),
    uniqueIndex("idx_maillists_mlid").on(t.mlid),
    index("idx_maillists_is_newsletter").on(t.is_newsletter),
    index("idx_maillists_active").on(t.active),
  ],
);

// ─── sender_bcc_domain ─────────────────────────────────────────────────────

export const sender_bcc_domain = vmailSchema.table(
  "sender_bcc_domain",
  {
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    bcc_address: varchar("bcc_address", { length: 255 }).notNull().default(""),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.domain] }),
    index("idx_sender_bcc_domain_bcc_address").on(t.bcc_address),
    index("idx_sender_bcc_domain_expired").on(t.expired),
    index("idx_sender_bcc_domain_active").on(t.active),
  ],
);

// ─── sender_bcc_user ───────────────────────────────────────────────────────

export const sender_bcc_user = vmailSchema.table(
  "sender_bcc_user",
  {
    username: varchar("username", { length: 255 }).notNull().default(""),
    bcc_address: varchar("bcc_address", { length: 255 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.username] }),
    index("idx_sender_bcc_user_bcc_address").on(t.bcc_address),
    index("idx_sender_bcc_user_domain").on(t.domain),
    index("idx_sender_bcc_user_expired").on(t.expired),
    index("idx_sender_bcc_user_active").on(t.active),
  ],
);

// ─── recipient_bcc_domain ──────────────────────────────────────────────────

export const recipient_bcc_domain = vmailSchema.table(
  "recipient_bcc_domain",
  {
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    bcc_address: varchar("bcc_address", { length: 255 }).notNull().default(""),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.domain] }),
    index("idx_recipient_bcc_domain_bcc_address").on(t.bcc_address),
    index("idx_recipient_bcc_domain_expired").on(t.expired),
    index("idx_recipient_bcc_domain_active").on(t.active),
  ],
);

// ─── recipient_bcc_user ────────────────────────────────────────────────────

export const recipient_bcc_user = vmailSchema.table(
  "recipient_bcc_user",
  {
    username: varchar("username", { length: 255 }).notNull().default(""),
    bcc_address: varchar("bcc_address", { length: 255 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    created: tsNow("created"),
    modified: tsNow("modified"),
    expired: tsNeverExpires("expired"),
    active: activeFlag("active"),
  },
  (t) => [
    primaryKey({ columns: [t.username] }),
    index("idx_recipient_bcc_user_bcc_address").on(t.bcc_address),
    index("idx_recipient_bcc_user_expired").on(t.expired),
    index("idx_recipient_bcc_user_active").on(t.active),
  ],
);

// ─── sender_relayhost ──────────────────────────────────────────────────────

export const sender_relayhost = vmailSchema.table(
  "sender_relayhost",
  {
    id: serial("id").primaryKey(),
    account: varchar("account", { length: 255 }).notNull().default(""),
    relayhost: varchar("relayhost", { length: 255 }).notNull().default(""),
  },
  (t) => [uniqueIndex("idx_sender_relayhost_account").on(t.account)],
);

// ─── deleted_mailboxes ─────────────────────────────────────────────────────

export const deleted_mailboxes = vmailSchema.table(
  "deleted_mailboxes",
  {
    id: serial("id").primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: false, mode: "date" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    username: varchar("username", { length: 255 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    maildir: varchar("maildir", { length: 255 }).notNull().default(""),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    messages: bigint("messages", { mode: "number" }).notNull().default(0),
    admin: varchar("admin", { length: 255 }).notNull().default(""),
    delete_date: date("delete_date", { mode: "string" }),
  },
  (t) => [
    index("idx_deleted_mailboxes_timestamp").on(t.timestamp),
    index("idx_deleted_mailboxes_username").on(t.username),
    index("idx_deleted_mailboxes_domain").on(t.domain),
    index("idx_deleted_mailboxes_admin").on(t.admin),
    index("idx_delete_date").on(t.delete_date),
  ],
);

// ─── share_folder ──────────────────────────────────────────────────────────

export const share_folder = vmailSchema.table(
  "share_folder",
  {
    from_user: varchar("from_user", { length: 255 }).notNull(),
    to_user: varchar("to_user", { length: 255 }).notNull(),
    dummy: char("dummy", { length: 1 }),
  },
  (t) => [
    primaryKey({ columns: [t.from_user, t.to_user] }),
    index("idx_share_folder_from_user").on(t.from_user),
    index("idx_share_folder_to_user").on(t.to_user),
  ],
);

// ─── anyone_shares ─────────────────────────────────────────────────────────

export const anyone_shares = vmailSchema.table(
  "anyone_shares",
  {
    from_user: varchar("from_user", { length: 255 }).notNull(),
    dummy: char("dummy", { length: 1 }),
  },
  (t) => [primaryKey({ columns: [t.from_user] })],
);

// ─── last_login ────────────────────────────────────────────────────────────
// Dovecot inserts both columns; iRedMail uses (username, domain) as the PK so
// Dovecot's ON CONFLICT semantics work without a separate trigger.

export const last_login = vmailSchema.table(
  "last_login",
  {
    username: varchar("username", { length: 255 }).notNull().default(""),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
    imap: bigint("imap", { mode: "number" }),
    pop3: bigint("pop3", { mode: "number" }),
    lda: bigint("lda", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.username, t.domain] }),
    index("idx_last_login_domain").on(t.domain),
    index("idx_last_login_imap").on(t.imap),
    index("idx_last_login_pop3").on(t.pop3),
    index("idx_last_login_lda").on(t.lda),
  ],
);

// ─── used_quota ────────────────────────────────────────────────────────────
// Dovecot writes here automatically - DO NOT mutate from application code.

export const used_quota = vmailSchema.table(
  "used_quota",
  {
    username: varchar("username", { length: 255 }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    messages: bigint("messages", { mode: "number" }).notNull().default(0),
    domain: varchar("domain", { length: 255 }).notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.username] }),
    index("idx_used_quota_domain").on(t.domain),
  ],
);

// ─── Type exports ──────────────────────────────────────────────────────────

export type Admin = typeof admin.$inferSelect;
export type Alias = typeof alias.$inferSelect;
export type Domain = typeof domain.$inferSelect;
export type Mailbox = typeof mailbox.$inferSelect;
export type Forwarding = typeof forwardings.$inferSelect;
export type AliasDomain = typeof alias_domain.$inferSelect;
export type DomainAdmin = typeof domain_admins.$inferSelect;
export type Maillist = typeof maillists.$inferSelect;
export type SenderBccDomain = typeof sender_bcc_domain.$inferSelect;
export type SenderBccUser = typeof sender_bcc_user.$inferSelect;
export type RecipientBccDomain = typeof recipient_bcc_domain.$inferSelect;
export type RecipientBccUser = typeof recipient_bcc_user.$inferSelect;
export type SenderRelayhost = typeof sender_relayhost.$inferSelect;
export type DeletedMailbox = typeof deleted_mailboxes.$inferSelect;
export type ShareFolder = typeof share_folder.$inferSelect;
export type AnyoneShare = typeof anyone_shares.$inferSelect;
export type LastLogin = typeof last_login.$inferSelect;
export type UsedQuota = typeof used_quota.$inferSelect;
export type Moderator = typeof moderators.$inferSelect;
export type MaillistOwner = typeof maillist_owners.$inferSelect;
