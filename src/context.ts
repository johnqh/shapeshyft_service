/**
 * @fileoverview Service configuration and the context every router closes over
 */

import type { RateLimitsConfig } from "@sudobility/ratelimit_service";
import { createLLMProvider } from "@sudobility/shapeshyft_engine";
import type {
  AuthAdapter,
  EmailSender,
  InvokeHooks,
  Logger,
  ProviderCredentialResolver,
  ServiceDb,
} from "./contracts.js";
import type { Encryption } from "./lib/encryption.js";
import { createProjectApiKeys, type ProjectApiKeys } from "./lib/api-key.js";
import { createUserApiKeys, type UserApiKeys } from "./lib/user-api-key.js";
import {
  createEntityApiKeyFormat,
  type EntityApiKeyFormat,
} from "./lib/entity-api-key.js";
import {
  createUserApiKeyCache,
  type UserApiKeyCache,
} from "./lib/user-api-key-cache.js";
import { createEntityAccess, type EntityAccess } from "./lib/entity-helpers.js";
import {
  createSubscriptionAccess,
  type SubscriptionAccess,
} from "./middleware/subscription.js";
import {
  createRateLimiting,
  DEFAULT_ENTITLEMENT_DISPLAY_NAMES,
  DEFAULT_RATE_LIMITS_CONFIG,
  type RateLimiting,
} from "./middleware/rateLimit.js";
import {
  createEndpointSchemas,
  type EndpointBindingShapes,
  type EndpointSchemas,
} from "./schemas/index.js";
import type { ServiceTables } from "./schema/tables.js";

export interface ShapeshyftServiceConfig {
  db: ServiceDb;
  tables: ServiceTables;
  /** e.g. `{ user: "shyft_", entity: "shyftent" }` -- entity has no trailing underscore */
  keyPrefixes: { user: string; entity: string };
  encryption: Encryption;
  auth: AuthAdapter;
  email: EmailSender;
  credentials: ProviderCredentialResolver;
  /** Extra zod fields validated on endpoint create/update. */
  endpointBinding?: EndpointBindingShapes;
  hooks?: InvokeHooks;
  /** Absent: subscription lookups and invoke rate limiting are skipped. */
  revenueCatApiKey?: string;
  rateLimits?: RateLimitsConfig;
  entitlementDisplayNames?: Record<string, string>;
  /** Default: `console`. */
  logger?: Logger;
  /** Default: the engine's `createLLMProvider`. Tests inject a fake. */
  createProvider?: typeof createLLMProvider;
}

export interface ServiceContext {
  db: ServiceDb;
  tables: ServiceTables;
  auth: AuthAdapter;
  email: EmailSender;
  credentials: ProviderCredentialResolver;
  hooks: InvokeHooks;
  logger: Logger;
  createProvider: typeof createLLMProvider;
  revenueCatApiKey: string | undefined;
  encryption: Encryption;
  projectApiKeys: ProjectApiKeys;
  userApiKeys: UserApiKeys;
  userApiKeyCache: UserApiKeyCache;
  entityApiKeyFormat: EntityApiKeyFormat;
  entityAccess: EntityAccess;
  subscription: SubscriptionAccess;
  rateLimiting: RateLimiting;
  schemas: EndpointSchemas;
}

export function buildContext(config: ShapeshyftServiceConfig): ServiceContext {
  const logger = config.logger ?? console;
  const userApiKeys = createUserApiKeys({
    prefix: config.keyPrefixes.user,
    encryption: config.encryption,
  });

  return {
    db: config.db,
    tables: config.tables,
    auth: config.auth,
    email: config.email,
    credentials: config.credentials,
    hooks: config.hooks ?? {},
    logger,
    createProvider: config.createProvider ?? createLLMProvider,
    revenueCatApiKey: config.revenueCatApiKey,
    encryption: config.encryption,
    projectApiKeys: createProjectApiKeys(config.encryption),
    userApiKeys,
    userApiKeyCache: createUserApiKeyCache({
      db: config.db,
      tables: config.tables,
      hashUserApiKey: userApiKeys.hashUserApiKey,
      logger,
    }),
    entityApiKeyFormat: createEntityApiKeyFormat(config.keyPrefixes.entity),
    entityAccess: createEntityAccess({
      db: config.db,
      tables: config.tables,
      entityKeyPrefix: config.keyPrefixes.entity,
    }),
    subscription: createSubscriptionAccess(config.revenueCatApiKey),
    rateLimiting: createRateLimiting({
      db: config.db,
      rateLimitCounters: config.tables.rateLimitCounters,
      revenueCatApiKey: config.revenueCatApiKey,
      rateLimitsConfig: config.rateLimits ?? DEFAULT_RATE_LIMITS_CONFIG,
      entitlementDisplayNames:
        config.entitlementDisplayNames ?? DEFAULT_ENTITLEMENT_DISPLAY_NAMES,
    }),
    schemas: createEndpointSchemas(config.endpointBinding),
  };
}
