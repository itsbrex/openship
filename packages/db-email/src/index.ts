/**
 * @repo/db-email - Drizzle schema + client for the email server's Postgres.
 *
 * Two schemas live in the same database:
 *   • vmail.*    - byte-faithful port of iRedMail's PG schema. Postfix and
 *                  Dovecot SQL maps query this directly. DO NOT reshape.
 *   • mail_app.* - Zero's app-state (settings, AI summaries, notes), FK'd
 *                  to vmail.mailbox.username.
 *
 * The schemas live in different Postgres schemas so they can be managed,
 * granted, and revoked independently. Their connection string is
 * `EMAIL_DATABASE_URL` - distinct from openship's `DATABASE_URL`.
 */

export * from "./schema";
export { getEmailDb, closeEmailDb, type EmailDatabase, type EmailDbConfig } from "./client";
