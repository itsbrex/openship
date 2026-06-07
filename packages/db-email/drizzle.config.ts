import { defineConfig } from "drizzle-kit";

/**
 * The email server runs against its own Postgres instance, separate from
 * openship's main database. `EMAIL_DATABASE_URL` is the only config required
 * to point at it.
 *
 * Schemas managed here:
 *   - vmail     - byte-faithful port of iRedMail's PostgreSQL schema. Do NOT
 *                 reshape; Postfix and Dovecot SQL maps depend on the exact
 *                 column names + types iRedMail ships with.
 *   - mail_app  - Zero email-client app state (settings, signatures, AI
 *                 summaries), foreign-keyed to vmail.mailbox.
 */
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Both schemas live in the same database; we want migrations + introspection
  // for both, so don't filter by schemaFilter.
  schemaFilter: ["vmail", "mail_app"],
  dbCredentials: {
    url:
      process.env.EMAIL_DATABASE_URL ||
      "postgres://vmailadmin:password@localhost:5432/vmail",
  },
});
