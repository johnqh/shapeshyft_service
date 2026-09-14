/**
 * @fileoverview Context variables the auth middleware sets on every request
 * @description Augments Hono's ContextVariableMap so `c.get("userId")` and
 * friends are typed in the service and in every app that mounts routes on it.
 * Re-exported from the package entry, which is what brings this augmentation
 * into a consumer's compilation.
 */

import type { DecodedIdToken } from "firebase-admin/auth";

export interface AuthContextVariables {
  firebaseUser: DecodedIdToken;
  userId: string;
  userEmail: string | null;
  siteAdmin: boolean;
  /**
   * How the caller authenticated. Neither key method has a firebaseUser.
   * "api_key" is a personal key (acts as a user); "entity_api_key" is an
   * entity key (acts as the entity itself).
   */
  authMethod: "firebase" | "api_key" | "entity_api_key";
  /** UUID of the user API key used, when authMethod is "api_key" */
  apiKeyId: string;
  /** UUID of the entity API key used, when authMethod is "entity_api_key" */
  entityApiKeyId: string;
  /** Entity the request acts as, when authMethod is "entity_api_key" */
  entityApiKeyEntityId: string;
}

declare module "hono" {
  interface ContextVariableMap extends AuthContextVariables {}
}
