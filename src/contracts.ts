/**
 * @fileoverview What an app supplies to shapeshyft_service
 * @description The provider-credential seam, invoke hooks, and the adapters that
 * replace module-level singletons (auth, email, logging).
 */

import type { Context } from "hono";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DecodedIdToken } from "firebase-admin/auth";
import type {
  getUserInfo,
  isAnonymousUser,
  isSiteAdmin,
} from "@sudobility/auth_service";
import type {
  EndpointBase,
  LlmProvider,
} from "@sudobility/shapeshyft_engine/types";
import type { ServiceTables } from "./schema/tables.js";

// =============================================================================
// Database
// =============================================================================

/** The Drizzle database the app connects. Tables are passed separately. */
export type ServiceDb = PostgresJsDatabase<any>;

/** The `tx` handed to a `db.transaction` callback. */
export type DbTransaction = Parameters<
  Parameters<ServiceDb["transaction"]>[0]
>[0];

export type EndpointRow = ServiceTables["endpoints"]["$inferSelect"];
export type EntityRow = ServiceTables["entities"]["$inferSelect"];
export type ProjectRow = ServiceTables["projects"]["$inferSelect"];

/** An endpoint as the service's routes return it. */
export interface EndpointRecord extends EndpointBase {
  llm_key_id: string | null;
  provider: LlmProvider | null;
}

// =============================================================================
// Provider credentials
// =============================================================================

/** A refusal. `message` is returned to the caller verbatim as `errorResponse(message)`. */
export interface ResolverFailure {
  ok: false;
  status: 400 | 404 | 500 | 503;
  message: string;
}

/** What to persist on an endpoint for its provider binding. */
export interface EndpointBinding {
  ok: true;
  provider: LlmProvider;
  /** ShapeShyft: the LlmApiKey UUID. Products without per-entity keys: null. */
  llmKeyId: string | null;
}

/** A live credential for one call. `provider` is authoritative for the call. */
export interface ResolvedCredential {
  ok: true;
  provider: LlmProvider;
  apiKey?: string;
  endpointUrl?: string;
  timeoutMs?: number;
}

export interface ProviderCredentialResolver {
  /**
   * Endpoint create (no `current`) or update (`current` set). `body` is the
   * validated request body, including the app's `endpointBinding` fields.
   */
  bindEndpoint(ctx: {
    entityId: string;
    body: Record<string, unknown>;
    current?: EndpointRow;
  }): Promise<EndpointBinding | ResolverFailure>;

  /** Invoke and prompt-preview time. */
  resolve(ctx: {
    entityId: string;
    endpoint: EndpointRow;
  }): Promise<ResolvedCredential | ResolverFailure>;
}

// =============================================================================
// Invoke hooks
// =============================================================================

export interface InvokeHooks {
  /**
   * After rate limiting, before the provider call. Return a Response to stop
   * the request with it (e.g. 402 insufficient credit). Not run for /prompt.
   */
  beforeInvoke?(ctx: {
    c: Context;
    entity: EntityRow;
    project: ProjectRow;
    endpoint: EndpointRow;
    provider: LlmProvider;
  }): Promise<Response | void>;

  /**
   * After a successful provider call, inside the transaction that inserts the
   * usage_analytics row. Throwing rolls that row back and fails the request 500.
   */
  afterInvoke?(ctx: {
    tx: DbTransaction;
    entity: EntityRow;
    endpoint: EndpointRow;
    usageAnalyticsId: string;
    provider: LlmProvider;
    model: string;
    usage: { promptTokens: number; completionTokens: number };
    providerCostMicroCents: bigint;
  }): Promise<void>;
}

// =============================================================================
// Adapters
// =============================================================================

/** Auth functions the app initialises (auth_service is process-global). */
export interface AuthAdapter {
  verifyIdToken(token: string): Promise<DecodedIdToken>;
  isSiteAdmin: typeof isSiteAdmin;
  isAnonymousUser: typeof isAnonymousUser;
  getUserInfo: typeof getUserInfo;
}

export interface EmailSender {
  sendInvitationEmail(params: {
    recipientEmail: string;
    entityName: string;
  }): Promise<void>;
}

/** `console` satisfies this; it is the default. */
export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
