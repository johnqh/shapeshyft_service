import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { client, columnInfo, resetSchema, SCHEMA } from "./utils/db.js";
import { initServiceTables } from "../src/schema/init.js";

describe("initServiceTables", () => {
  beforeAll(async () => {
    await resetSchema();
  });

  afterAll(async () => {
    await client.end();
  });

  it("is idempotent", async () => {
    await expect(
      initServiceTables(client, { schemaName: SCHEMA, indexPrefix: SCHEMA })
    ).resolves.toBeUndefined();
  });

  it("creates every shared table", async () => {
    const rows = await client`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${SCHEMA}
    `;
    const names = rows.map(r => r.table_name as string);
    for (const t of [
      "users",
      "user_settings",
      "entities",
      "entity_members",
      "entity_invitations",
      "entity_api_keys",
      "user_api_keys",
      "projects",
      "endpoints",
      "usage_analytics",
      "entity_storage_configs",
    ]) {
      expect(names).toContain(t);
    }
    expect(names).not.toContain("llm_api_keys");
  });

  it("gives endpoints a nullable provider and a nullable llm_key_id", async () => {
    expect(await columnInfo("endpoints", "provider")).toEqual({
      is_nullable: "YES",
      udt_name: "llm_provider",
    });
    expect((await columnInfo("endpoints", "llm_key_id"))?.is_nullable).toBe(
      "YES"
    );
  });

  it("adds no foreign key from endpoints.llm_key_id", async () => {
    const rows = await client`
      SELECT a.attname AS column_name
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
      WHERE n.nspname = ${SCHEMA} AND t.relname = 'endpoints' AND c.contype = 'f'
    `;
    expect(rows.map(r => r.column_name)).toEqual(["project_id"]);
  });

  it("relaxes a pre-existing NOT NULL llm_key_id and adds provider", async () => {
    await client.unsafe(`ALTER TABLE ${SCHEMA}.endpoints DROP COLUMN provider`);
    await client.unsafe(
      `ALTER TABLE ${SCHEMA}.endpoints ALTER COLUMN llm_key_id SET NOT NULL`
    );
    await initServiceTables(client, {
      schemaName: SCHEMA,
      indexPrefix: SCHEMA,
    });
    expect((await columnInfo("endpoints", "llm_key_id"))?.is_nullable).toBe(
      "YES"
    );
    expect(await columnInfo("endpoints", "provider")).toBeDefined();
  });
});
