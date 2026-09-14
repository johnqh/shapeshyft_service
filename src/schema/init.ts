/**
 * @fileoverview Idempotent DDL for the shared tables
 * @description Runs on every server boot. Every statement is IF NOT EXISTS or
 * guarded, so re-running is safe. Identifiers cannot be bound as parameters,
 * so schema and prefix are validated and interpolated into `client.unsafe`.
 */

import type { Sql } from "postgres";
import { initRateLimitTable } from "@sudobility/ratelimit_service";
import { runEntityMigration } from "@sudobility/entity_service";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${what} "${value}": must match ${IDENTIFIER}`);
  }
  return value;
}

export async function initServiceTables(
  client: Sql,
  opts: { schemaName: string; indexPrefix: string }
): Promise<void> {
  const s = identifier(opts.schemaName, "schemaName");
  const p = identifier(opts.indexPrefix, "indexPrefix");

  // Create schema if it doesn't exist
  await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${s}`);

  // Create enums (if they don't exist)
  await client.unsafe(`
    DO $$ BEGIN
      CREATE TYPE ${s}.llm_provider AS ENUM ('openai', 'anthropic', 'gemini', 'mistral', 'cohere', 'groq', 'xai', 'deepseek', 'perplexity', 'lm_studio');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);

  // Add new enum values if they don't exist (migration for existing databases)
  await client.unsafe(`
    DO $$
    BEGIN
      -- Add mistral if not exists
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'mistral' AND enumtypid = '${s}.llm_provider'::regtype) THEN
        ALTER TYPE ${s}.llm_provider ADD VALUE 'mistral';
      END IF;
      -- Add cohere if not exists
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'cohere' AND enumtypid = '${s}.llm_provider'::regtype) THEN
        ALTER TYPE ${s}.llm_provider ADD VALUE 'cohere';
      END IF;
      -- Add groq if not exists
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'groq' AND enumtypid = '${s}.llm_provider'::regtype) THEN
        ALTER TYPE ${s}.llm_provider ADD VALUE 'groq';
      END IF;
      -- Add xai if not exists
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'xai' AND enumtypid = '${s}.llm_provider'::regtype) THEN
        ALTER TYPE ${s}.llm_provider ADD VALUE 'xai';
      END IF;
      -- Add deepseek if not exists
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'deepseek' AND enumtypid = '${s}.llm_provider'::regtype) THEN
        ALTER TYPE ${s}.llm_provider ADD VALUE 'deepseek';
      END IF;
      -- Add perplexity if not exists
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'perplexity' AND enumtypid = '${s}.llm_provider'::regtype) THEN
        ALTER TYPE ${s}.llm_provider ADD VALUE 'perplexity';
      END IF;
      -- Add lm_studio if not exists
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'lm_studio' AND enumtypid = '${s}.llm_provider'::regtype) THEN
        ALTER TYPE ${s}.llm_provider ADD VALUE 'lm_studio';
      END IF;
    END $$;
  `);

  await client.unsafe(`
    DO $$ BEGIN
      CREATE TYPE ${s}.http_method AS ENUM ('GET', 'POST');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);

  // =============================================================================
  // Step 1: Create users and user_settings tables
  // firebase_uid is now the primary key
  // =============================================================================

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${s}.users (
      firebase_uid VARCHAR(128) PRIMARY KEY,
      email VARCHAR(255),
      display_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${s}.user_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      firebase_uid VARCHAR(128) NOT NULL UNIQUE REFERENCES ${s}.users(firebase_uid) ON DELETE CASCADE,
      organization_name VARCHAR(255),
      organization_path VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // =============================================================================
  // Step 2: Run entity migration (creates entities, entity_members tables)
  // This must happen BEFORE tables that reference entities.id
  // =============================================================================

  await runEntityMigration({
    client: client as any, // postgres type versions can differ under bun link
    schemaName: s,
    indexPrefix: p,
    migrateProjects: false, // Tables are created fresh with entity_id
    migrateUsers: false, // Personal entities created on-demand via EntityHelper
  });

  // =============================================================================
  // Step 2b: Create user_api_keys table (references users.firebase_uid)
  // Personal API keys used as an alternative to a Firebase ID token.
  // =============================================================================

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${s}.user_api_keys (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      firebase_uid VARCHAR(128) NOT NULL REFERENCES ${s}.users(firebase_uid) ON DELETE CASCADE,
      key_name VARCHAR(255) NOT NULL,
      key_hash VARCHAR(64) NOT NULL UNIQUE,
      key_prefix VARCHAR(20) NOT NULL,
      encrypted_key TEXT NOT NULL,
      encryption_iv VARCHAR(32) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      last_used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await client.unsafe(`
    CREATE INDEX IF NOT EXISTS ${p}_user_api_keys_user_idx
      ON ${s}.user_api_keys(firebase_uid)
  `);

  await client.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${p}_user_api_keys_hash_idx
      ON ${s}.user_api_keys(key_hash)
  `);

  // =============================================================================
  // Step 2c: Create entity_api_keys table (references entities.id)
  // Entity-scoped keys used by CI, scripts, and MCP clients.
  // =============================================================================

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${s}.entity_api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id UUID NOT NULL REFERENCES ${s}.entities(id) ON DELETE CASCADE,
      key_name VARCHAR(255) NOT NULL,
      key_hash VARCHAR(64) NOT NULL UNIQUE,
      key_prefix VARCHAR(20) NOT NULL,
      created_by_user_id VARCHAR(128) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${p}_entity_api_keys_hash_idx
      ON ${s}.entity_api_keys(key_hash)
  `);

  await client.unsafe(`
    CREATE INDEX IF NOT EXISTS ${p}_entity_api_keys_entity_idx
      ON ${s}.entity_api_keys(entity_id)
  `);

  await client.unsafe(`
    CREATE INDEX IF NOT EXISTS ${p}_entity_api_keys_active_idx
      ON ${s}.entity_api_keys(is_active)
  `);

  // =============================================================================
  // Step 4: Create projects table (references entities.id)
  // =============================================================================

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${s}.projects (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id UUID NOT NULL REFERENCES ${s}.entities(id) ON DELETE CASCADE,
      project_name VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT true,
      encrypted_api_key TEXT,
      api_key_iv VARCHAR(32),
      api_key_prefix VARCHAR(20),
      api_key_created_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Create unique index for project_name per entity
  await client.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS unique_project_per_entity
    ON ${s}.projects(entity_id, project_name)
  `);

  // Create index for entity_id lookups
  await client.unsafe(`
    CREATE INDEX IF NOT EXISTS ${p}_projects_entity_idx
    ON ${s}.projects(entity_id)
  `);

  // =============================================================================
  // Step 5: Create endpoints table (references projects.uuid)
  // =============================================================================

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${s}.endpoints (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES ${s}.projects(uuid) ON DELETE CASCADE,
      endpoint_name VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      http_method ${s}.http_method NOT NULL DEFAULT 'POST',
      llm_key_id UUID,
      provider ${s}.llm_provider,
      model VARCHAR(255),
      input_schema JSONB,
      output_schema JSONB,
      instructions TEXT,
      context TEXT,
      is_active BOOLEAN DEFAULT true,
      ip_allowlist JSONB,
      call_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(project_id, endpoint_name)
    )
  `);

  // Add model column if it doesn't exist (migration for existing tables)
  await client.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
        AND table_name = 'endpoints'
        AND column_name = 'model'
      ) THEN
        ALTER TABLE ${s}.endpoints ADD COLUMN model VARCHAR(255);
      END IF;
    END $$;
  `);

  // Add call_count column if it doesn't exist (migration for existing tables).
  // Existing endpoints start at 0 rather than backfilling from usage_analytics:
  // the counter is a forward-looking tally, and a backfill would silently
  // disagree with any analytics rows that have since been pruned.
  await client.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
        AND table_name = 'endpoints'
        AND column_name = 'call_count'
      ) THEN
        ALTER TABLE ${s}.endpoints
          ADD COLUMN call_count INTEGER NOT NULL DEFAULT 0;
      END IF;
    END $$;
  `);

  // Create index for project_id lookups
  await client.unsafe(`
    CREATE INDEX IF NOT EXISTS ${p}_endpoints_project_idx
    ON ${s}.endpoints(project_id)
  `);

  // =============================================================================
  // Step 6: Create usage_analytics table (references endpoints.uuid)
  // =============================================================================

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${s}.usage_analytics (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint_id UUID NOT NULL REFERENCES ${s}.endpoints(uuid) ON DELETE CASCADE,
      timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
      success BOOLEAN NOT NULL,
      error_message TEXT,
      tokens_input INTEGER,
      tokens_output INTEGER,
      latency_ms INTEGER,
      estimated_cost_cents INTEGER,
      request_metadata JSONB
    )
  `);

  // Create indexes for analytics queries
  await client.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_usage_endpoint_timestamp
    ON ${s}.usage_analytics(endpoint_id, timestamp DESC)
  `);

  // =============================================================================
  // Step 7: Rate limit counters table
  // =============================================================================

  await initRateLimitTable(client, s, p);

  // =============================================================================
  // Step 8: Entity Storage Configs table (for generated media uploads)
  // =============================================================================

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${s}.entity_storage_configs (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id UUID NOT NULL UNIQUE REFERENCES ${s}.entities(id) ON DELETE CASCADE,
      provider VARCHAR(20) NOT NULL,
      bucket VARCHAR(255) NOT NULL,
      path_prefix VARCHAR(500),
      encrypted_credentials TEXT NOT NULL,
      encryption_iv VARCHAR(32) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      created_by VARCHAR(128) NOT NULL
    )
  `);

  // Create index for entity_id lookups
  await client.unsafe(`
    CREATE INDEX IF NOT EXISTS ${p}_entity_storage_configs_entity_idx
    ON ${s}.entity_storage_configs(entity_id)
  `);

  // =============================================================================
  // Step 9: Add multimodal columns to endpoints table (migration for existing DBs)
  // =============================================================================

  // Add expects_media_output column
  await client.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
        AND table_name = 'endpoints'
        AND column_name = 'expects_media_output'
      ) THEN
        ALTER TABLE ${s}.endpoints ADD COLUMN expects_media_output JSONB;
      END IF;
    END $$;
  `);

  // Add output_media_format column
  await client.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
        AND table_name = 'endpoints'
        AND column_name = 'output_media_format'
      ) THEN
        ALTER TABLE ${s}.endpoints ADD COLUMN output_media_format VARCHAR(20);
      END IF;
    END $$;
  `);

  // Add web_search column
  await client.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
        AND table_name = 'endpoints'
        AND column_name = 'web_search'
      ) THEN
        ALTER TABLE ${s}.endpoints ADD COLUMN web_search BOOLEAN DEFAULT false;
      END IF;
    END $$;
  `);

  // Add temperature column
  await client.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
        AND table_name = 'endpoints'
        AND column_name = 'temperature'
      ) THEN
        ALTER TABLE ${s}.endpoints ADD COLUMN temperature REAL;
      END IF;
    END $$;
  `);

  // Add transcription_extraction_model column
  await client.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
        AND table_name = 'endpoints'
        AND column_name = 'transcription_extraction_model'
      ) THEN
        ALTER TABLE ${s}.endpoints ADD COLUMN transcription_extraction_model VARCHAR(255);
      END IF;
    END $$;
  `);

  // Add max_output_tokens column.
  // Intentionally nullable with NO default and NO backfill: NULL means "no
  // runaway protection", and existing endpoints must keep behaving exactly as
  // they did. Adding a default here would silently cap live endpoints whose
  // callers depend on longer answers.
  await client.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = '${s}'
        AND table_name = 'endpoints'
        AND column_name = 'max_output_tokens'
      ) THEN
        ALTER TABLE ${s}.endpoints ADD COLUMN max_output_tokens INTEGER;
      END IF;
    END $$;
  `);

  // =============================================================================
  // Step 10: Provider binding (service extraction)
  // provider: which LLM the endpoint calls, written by bindEndpoint.
  // llm_key_id: relaxed to nullable; products without per-entity keys leave it
  // null. Apps that keep a key table add their own FK and backfill provider.
  // =============================================================================

  await client.unsafe(`
    ALTER TABLE ${s}.endpoints ADD COLUMN IF NOT EXISTS provider ${s}.llm_provider
  `);

  await client.unsafe(`
    ALTER TABLE ${s}.endpoints ALTER COLUMN llm_key_id DROP NOT NULL
  `);
}
