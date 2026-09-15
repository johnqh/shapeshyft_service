/**
 * @fileoverview Lazy PostgreSQL connection
 * @description Nothing connects at import time: the client is created on first
 * use, so scripts and tests can import a shell's `db` without `DATABASE_URL`.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

export interface LazyDatabase<TSchema extends Record<string, unknown>> {
  /** A drizzle instance that connects on first property access. */
  db: PostgresJsDatabase<TSchema>;
  /** The underlying postgres.js client, created on first call. */
  client(): Sql;
  /** Close the client, if one was created. The next use reconnects. */
  close(): Promise<void>;
}

/**
 * @param connectionString - Called on first use, so a missing URL fails then,
 *   not at import.
 * @param schema - The drizzle schema object.
 */
export function createLazyDatabase<TSchema extends Record<string, unknown>>(
  connectionString: () => string,
  schema: TSchema
): LazyDatabase<TSchema> {
  let sql: Sql | null = null;
  let instance: PostgresJsDatabase<TSchema> | null = null;

  const client = () => (sql ??= postgres(connectionString()));

  const db = new Proxy({} as PostgresJsDatabase<TSchema>, {
    get(_, prop) {
      instance ??= drizzle(client(), { schema });
      return (instance as unknown as Record<string | symbol, unknown>)[prop];
    },
  });

  return {
    db,
    client,
    async close() {
      if (sql) {
        await sql.end();
        sql = null;
        instance = null;
      }
    },
  };
}
