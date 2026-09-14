/**
 * @fileoverview Drizzle table factories for the shared schema
 * @description Everything in shapeshyft_api's schema except `llm_api_keys`,
 * built against a caller-supplied pgSchema so each product keeps its own
 * PostgreSQL schema (`shapeshyft`, `shaperouter`).
 */

import {
  pgEnum,
  type PgSchema,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  integer,
  bigint,
  jsonb,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createRateLimitCountersTable } from "@sudobility/ratelimit_service";
import {
  createEntitiesTable,
  createEntityMembersTable,
  createEntityInvitationsTable,
  createEntityApiKeysTable,
} from "@sudobility/entity_service";

export const LLM_PROVIDER_VALUES = [
  "openai",
  "anthropic",
  "gemini",
  "mistral",
  "cohere",
  "groq",
  "xai",
  "deepseek",
  "perplexity",
  "lm_studio",
] as const;

export function createServiceTables(
  schema: PgSchema,
  opts: { indexPrefix: string }
) {
  const p = opts.indexPrefix;

  const llmProviderEnum = pgEnum("llm_provider", LLM_PROVIDER_VALUES);
  const httpMethodEnum = pgEnum("http_method", ["GET", "POST"]);

  // =============================================================================
  // Users Table
  // firebase_uid is the primary key - no internal UUID needed
  // =============================================================================

  const users = schema.table("users", {
    firebase_uid: varchar("firebase_uid", { length: 128 }).primaryKey(),
    email: varchar("email", { length: 255 }),
    display_name: varchar("display_name", { length: 255 }),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  });

  // =============================================================================
  // User Settings Table
  // =============================================================================

  const userSettings = schema.table("user_settings", {
    id: uuid("id").primaryKey().defaultRandom(),
    firebase_uid: varchar("firebase_uid", { length: 128 })
      .notNull()
      .references(() => users.firebase_uid, { onDelete: "cascade" })
      .unique(),
    organization_name: varchar("organization_name", { length: 255 }),
    organization_path: varchar("organization_path", { length: 255 })
      .notNull()
      .unique(),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  });

  // =============================================================================
  // Entity Tables (from @sudobility/entity_service)
  // Must be defined before tables that reference them
  // =============================================================================

  const entities = createEntitiesTable(schema, p);
  const entityMembers = createEntityMembersTable(schema, p);
  const entityInvitations = createEntityInvitationsTable(schema, p);
  /**
   * Entity-scoped API keys ("<entity prefix>_..."). Authenticate a caller as the entity
   * itself -- CI jobs, scripts, and MCP clients that outlive any one member.
   * Hash-only storage, so a key is revealed once at creation.
   */
  const entityApiKeys = createEntityApiKeysTable(schema, p);

  // =============================================================================
  // Entity Storage Configs Table
  // User-provided cloud storage configuration for generated media
  // =============================================================================

  const entityStorageConfigs = schema.table(
    "entity_storage_configs",
    {
      uuid: uuid("uuid").primaryKey().defaultRandom(),
      entity_id: uuid("entity_id")
        .notNull()
        .references(() => entities.id, { onDelete: "cascade" })
        .unique(), // One storage config per entity
      provider: varchar("provider", { length: 20 }).notNull(), // "gcs" | "s3"
      bucket: varchar("bucket", { length: 255 }).notNull(),
      path_prefix: varchar("path_prefix", { length: 500 }), // e.g., "generated/"
      // Encrypted credentials (AES-256-CBC, see lib/encryption)
      encrypted_credentials: text("encrypted_credentials").notNull(),
      encryption_iv: varchar("encryption_iv", { length: 32 }).notNull(),
      // Audit fields
      created_at: timestamp("created_at").defaultNow(),
      updated_at: timestamp("updated_at").defaultNow(),
      created_by: varchar("created_by", { length: 128 }).notNull(), // Firebase UID
    },
    table => ({
      entityIdx: index(`${p}_entity_storage_configs_entity_idx`).on(
        table.entity_id
      ),
    })
  );

  // =============================================================================
  // User API Keys Table
  // Personal API keys ("<user prefix>...") that authenticate a user against the admin
  // routes exactly as a Firebase ID token does. A user may hold several.
  // Looked up by SHA-256 hash; the encrypted copy exists so the owner can reveal
  // the key again from the dashboard.
  // =============================================================================

  const userApiKeys = schema.table(
    "user_api_keys",
    {
      uuid: uuid("uuid").primaryKey().defaultRandom(),
      firebase_uid: varchar("firebase_uid", { length: 128 })
        .notNull()
        .references(() => users.firebase_uid, { onDelete: "cascade" }),
      key_name: varchar("key_name", { length: 255 }).notNull(),
      /** SHA-256 hex digest of the key — the authentication lookup index */
      key_hash: varchar("key_hash", { length: 64 }).notNull().unique(),
      /** First characters of the key, for display in listings */
      key_prefix: varchar("key_prefix", { length: 20 }).notNull(),
      /** AES-256-CBC ciphertext so the owner can copy the key again */
      encrypted_key: text("encrypted_key").notNull(),
      encryption_iv: varchar("encryption_iv", { length: 32 }).notNull(),
      is_active: boolean("is_active").default(true).notNull(),
      last_used_at: timestamp("last_used_at"),
      created_at: timestamp("created_at").defaultNow(),
      updated_at: timestamp("updated_at").defaultNow(),
    },
    table => ({
      userIdx: index(`${p}_user_api_keys_user_idx`).on(table.firebase_uid),
      hashIdx: uniqueIndex(`${p}_user_api_keys_hash_idx`).on(table.key_hash),
    })
  );

  // =============================================================================
  // Projects Table
  // =============================================================================

  const projects = schema.table(
    "projects",
    {
      uuid: uuid("uuid").primaryKey().defaultRandom(),
      entity_id: uuid("entity_id")
        .notNull()
        .references(() => entities.id, { onDelete: "cascade" }),
      project_name: varchar("project_name", { length: 255 }).notNull(),
      display_name: varchar("display_name", { length: 255 }).notNull(),
      description: text("description"),
      is_active: boolean("is_active").default(true),
      // API Key fields
      encrypted_api_key: text("encrypted_api_key"),
      api_key_iv: varchar("api_key_iv", { length: 32 }),
      api_key_prefix: varchar("api_key_prefix", { length: 20 }),
      api_key_created_at: timestamp("api_key_created_at"),
      created_at: timestamp("created_at").defaultNow(),
      updated_at: timestamp("updated_at").defaultNow(),
    },
    table => ({
      uniqueProjectPerEntity: uniqueIndex("unique_project_per_entity").on(
        table.entity_id,
        table.project_name
      ),
      entityIdx: index(`${p}_projects_entity_idx`).on(table.entity_id),
    })
  );

  // =============================================================================
  // Endpoints Table
  // =============================================================================

  const endpoints = schema.table(
    "endpoints",
    {
      uuid: uuid("uuid").primaryKey().defaultRandom(),
      project_id: uuid("project_id")
        .notNull()
        .references(() => projects.uuid, { onDelete: "cascade" }),
      endpoint_name: varchar("endpoint_name", { length: 255 }).notNull(),
      display_name: varchar("display_name", { length: 255 }).notNull(),
      http_method: httpMethodEnum("http_method").notNull().default("POST"),
      /**
       * The product's credential binding. ShapeShyft stores an llm_api_keys UUID
       * and adds its own foreign key; products with site-owned provider keys
       * leave it null. No reference here: the service has no key table.
       */
      llm_key_id: uuid("llm_key_id"),
      /**
       * Provider this endpoint calls, written by bindEndpoint on create/update.
       * Nullable so a rolling deploy cannot break inserts from an older server;
       * the invoke path uses the resolver's provider, never this column alone.
       */
      provider: llmProviderEnum("provider"),
      model: varchar("model", { length: 255 }),
      input_schema: jsonb("input_schema"),
      output_schema: jsonb("output_schema"),
      instructions: text("instructions"),
      context: text("context"),
      is_active: boolean("is_active").default(true),
      // IP Allowlist - JSON array of IPv4 addresses, null = allow all
      ip_allowlist: jsonb("ip_allowlist"),
      // Media output configuration - what media types this endpoint expects to generate
      expects_media_output: jsonb("expects_media_output"),
      // How to return generated media ("base64" for inline, "url" for cloud storage)
      output_media_format: varchar("output_media_format", { length: 20 }),
      // Enable web search for supported providers (OpenAI Responses API)
      web_search: boolean("web_search").default(false),
      /**
       * Sampling temperature for this endpoint's model, or NULL to say nothing.
       *
       * NULL rather than a default of 0, and the distinction is load-bearing:
       * the adapters disagree about what "unset" means. OpenAI, Gemini, Groq and
       * the custom provider default it to 0; Anthropic omits the field entirely,
       * because Opus 4.7+ and Sonnet 5 reject `temperature` with a 400. A column
       * defaulting to 0 would start sending a value to the models that refuse
       * one, so every endpoint that predates this keeps its NULL and its
       * behaviour.
       */
      temperature: real("temperature"),
      /**
       * Ceiling on tokens the model may generate per invocation.
       *
       * Deliberately has NO database default: a NULL means "no protection", and
       * every endpoint that predates this column keeps that NULL. New endpoints
       * get DEFAULT_MAX_OUTPUT_TOKENS applied at the API layer instead, so the
       * default reaches new rows without silently re-capping existing ones.
       */
      max_output_tokens: integer("max_output_tokens"),
      // For Whisper endpoints: model to use for structured extraction from transcription
      transcription_extraction_model: varchar(
        "transcription_extraction_model",
        {
          length: 255,
        }
      ),
      /**
       * Lifetime invocation count, incremented on every call -- successful or
       * failed -- alongside the usage_analytics row for that call.
       */
      call_count: integer("call_count").notNull().default(0),
      created_at: timestamp("created_at").defaultNow(),
      updated_at: timestamp("updated_at").defaultNow(),
    },
    table => ({
      uniqueEndpointPerProject: uniqueIndex("unique_endpoint_per_project").on(
        table.project_id,
        table.endpoint_name
      ),
      projectIdx: index(`${p}_endpoints_project_idx`).on(table.project_id),
    })
  );

  // =============================================================================
  // Usage Analytics Table
  // =============================================================================

  const usageAnalytics = schema.table("usage_analytics", {
    uuid: uuid("uuid").primaryKey().defaultRandom(),
    endpoint_id: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.uuid, { onDelete: "cascade" }),
    timestamp: timestamp("timestamp").notNull().defaultNow(),
    success: boolean("success").notNull(),
    error_message: text("error_message"),
    tokens_input: integer("tokens_input"),
    tokens_output: integer("tokens_output"),
    latency_ms: integer("latency_ms"),
    /** Legacy: whole cents, so nearly every call rounded to 0. Kept for old rows. */
    estimated_cost_cents: integer("estimated_cost_cents"),
    /** Estimated cost in micro-cents (10^-6 cent). NULL on rows written before it existed. */
    estimated_cost_micro_cents: bigint("estimated_cost_micro_cents", {
      mode: "bigint",
    }),
    request_metadata: jsonb("request_metadata"),
  });

  // =============================================================================
  // Rate Limit Counters Table (from @sudobility/subscription_service)
  // =============================================================================

  const rateLimitCounters = createRateLimitCountersTable(schema, p);

  return {
    llmProviderEnum,
    httpMethodEnum,
    users,
    userSettings,
    entities,
    entityMembers,
    entityInvitations,
    entityApiKeys,
    entityStorageConfigs,
    userApiKeys,
    projects,
    endpoints,
    usageAnalytics,
    rateLimitCounters,
  };
}

export type ServiceTables = ReturnType<typeof createServiceTables>;
