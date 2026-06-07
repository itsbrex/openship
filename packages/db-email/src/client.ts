/**
 * Drizzle client bound to the email server's Postgres ($EMAIL_DATABASE_URL).
 *
 * Kept intentionally small - no driver-swapping, no pglite, no global state.
 * The email server is a long-running Node/Bun process on the mail VPS; one
 * `pg` Pool per process is the right model.
 */

import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type EmailDatabase = NodePgDatabase<typeof schema>;

export interface EmailDbConfig {
  /** Connection string. Defaults to $EMAIL_DATABASE_URL. */
  url?: string;
  /** Extra pg.Pool options (max connections, ssl, etc.). */
  pool?: Omit<PoolConfig, "connectionString">;
}

let _db: EmailDatabase | null = null;
let _pool: Pool | null = null;

/**
 * Get the singleton email DB connection. Lazily initialized on first call.
 * Safe to call multiple times - returns the same Pool/Drizzle instance.
 */
export function getEmailDb(config: EmailDbConfig = {}): EmailDatabase {
  if (_db) return _db;

  const connectionString = config.url ?? process.env.EMAIL_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "EMAIL_DATABASE_URL is not set. The email server reads/writes against " +
        "its own Postgres instance - provide a connection string via env or pass " +
        "{ url } to getEmailDb().",
    );
  }

  _pool = new Pool({ connectionString, ...(config.pool ?? {}) });
  _db = drizzle(_pool, { schema });
  return _db;
}

/** Tear down the connection pool. For tests / graceful shutdown only. */
export async function closeEmailDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}
