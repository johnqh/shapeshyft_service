import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { pgSchema } from "drizzle-orm/pg-core";
import { createServiceTables } from "../../src/schema/tables.js";
import { initServiceTables } from "../../src/schema/init.js";

/** A schema of its own, so these suites never touch a product's tables. */
export const SCHEMA = "shapeshyft_service_test";

export const client = postgres(process.env.DATABASE_URL!, {
  onnotice: () => {},
});
export const db = drizzle(client);
export const tables = createServiceTables(pgSchema(SCHEMA), {
  indexPrefix: SCHEMA,
});

export async function resetSchema(): Promise<void> {
  await client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await initServiceTables(client, { schemaName: SCHEMA, indexPrefix: SCHEMA });
}

export async function columnInfo(table: string, column: string) {
  const rows = await client`
    SELECT is_nullable, udt_name FROM information_schema.columns
    WHERE table_schema = ${SCHEMA} AND table_name = ${table} AND column_name = ${column}
  `;
  return rows[0] as { is_nullable: "YES" | "NO"; udt_name: string } | undefined;
}
