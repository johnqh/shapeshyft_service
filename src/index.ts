/**
 * @fileoverview @sudobility/shapeshyft_service
 * @description Tables, routes and middleware shared by ShapeShyft and
 * ShapeRouter. Provider credentials come from the app via
 * ProviderCredentialResolver; billing seams via InvokeHooks.
 */

export {
  createShapeshyftService,
  type BuildRoutesOptions,
  type ShapeshyftService,
} from "./service.js";
export {
  buildContext,
  type ServiceContext,
  type ShapeshyftServiceConfig,
} from "./context.js";
export type {
  AuthAdapter,
  DbTransaction,
  EmailSender,
  EndpointBinding,
  EndpointRecord,
  EndpointRow,
  EntityRow,
  InvokeHooks,
  Logger,
  ProjectRow,
  ProviderCredentialResolver,
  ResolvedCredential,
  ResolverFailure,
  ServiceDb,
} from "./contracts.js";
export {
  createServiceTables,
  LLM_PROVIDER_VALUES,
  type ServiceTables,
} from "./schema/tables.js";
export { initServiceTables } from "./schema/init.js";
export {
  createEncryption,
  generateEncryptionKey,
  type Encryption,
} from "./lib/encryption.js";
export { toMicroCents } from "./lib/money.js";
export {
  getActor,
  getPermissionErrorStatus,
  userActor,
  ENTITY_API_KEY_PERMISSIONS,
  type EntityAccess,
  type EntityActor,
  type EntityPermissionResult,
} from "./lib/entity-helpers.js";
export {
  DEFAULT_RATE_LIMITS_CONFIG,
  DEFAULT_ENTITLEMENT_DISPLAY_NAMES,
} from "./middleware/rateLimit.js";
export * from "./schemas/index.js";
export {
  collectForwardingHeaders,
  FORWARDING_HEADERS,
  isIpLiteral,
  isIpv4,
  isIpv6,
  isRoutableClientIp,
  normalizeClientIp,
  resolveAllowlistIp,
  resolveCallerIp,
} from "./lib/client-ip.js";
export type { AuthContextVariables } from "./hono-context.js";

// Process bootstrap for the API shells: env, database, auth, email, server.
export { createEnvReader, parseEnvFile, type EnvReader } from "./server/env.js";
export { createLazyDatabase, type LazyDatabase } from "./server/database.js";
export {
  createFirebaseAuth,
  type FirebaseAuthConfig,
} from "./server/firebase-auth.js";
export {
  createInvitationEmailSender,
  renderInvitationEmail,
  escapeHtml,
  type InvitationEmailConfig,
} from "./server/invitation-email.js";
export {
  createApiServer,
  DEFAULT_BODY_LIMIT_BYTES,
  type ApiServer,
  type ApiServerConfig,
} from "./server/api-server.js";
