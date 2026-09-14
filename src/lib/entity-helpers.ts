/**
 * @fileoverview Shared entity permission helpers
 * @description Builds the entity helpers and the shared
 * `getEntityWithPermission()` check for one product's database, plus the
 * actor helpers every route uses.
 */

import {
  createEntityHelpers,
  MANAGER_PERMISSIONS,
  type InvitationHelperConfig,
  type ApiKeyHelperConfig,
  type Entity,
  type EntityPermissions,
} from "@sudobility/entity_service";
import type { Context } from "hono";
import type { ServiceDb } from "../contracts.js";
import type { ServiceTables } from "../schema/tables.js";

// =============================================================================
// Permission Result Type
// =============================================================================

/** Successful permission check result */
interface PermissionSuccess {
  entity: Entity;
  error?: never;
  errorCode?: never;
}

/** Failed permission check result */
interface PermissionFailure {
  entity?: never;
  error: string;
  errorCode: string;
}

/** Discriminated union for permission check results */
export type EntityPermissionResult = PermissionSuccess | PermissionFailure;

// =============================================================================
// Actors
// =============================================================================

/**
 * Who is making a request.
 *
 * A Firebase token or a personal API key identifies a *user*, whose access is
 * decided by their membership role. An entity API key identifies the *entity*
 * itself -- it carries no membership, so it is authorised by matching the
 * entity it was issued for.
 */
export type EntityActor =
  | { kind: "user"; userId: string }
  | { kind: "entity_api_key"; entityId: string; keyId: string };

/** Build a user actor. Accepts a bare Firebase UID for brevity at call sites. */
export function userActor(userId: string): EntityActor {
  return { kind: "user", userId };
}

/**
 * Permissions granted to an entity API key over its own entity.
 *
 * Manager-level: it may manage projects, endpoints, provider keys, and storage,
 * but never members or roles. Minting further API keys is blocked separately in
 * the entity API key routes, so a leaked key cannot mint more of itself.
 */
export const ENTITY_API_KEY_PERMISSIONS: EntityPermissions =
  MANAGER_PERMISSIONS;

// =============================================================================
// Shared Permission Helper
// =============================================================================

/**
 * Entity helpers and the permission check, bound to one product's database.
 * Routes read these from the service context rather than a module singleton.
 */
export function createEntityAccess(opts: {
  db: ServiceDb;
  tables: ServiceTables;
  entityKeyPrefix: string;
}) {
  const config: InvitationHelperConfig & ApiKeyHelperConfig = {
    db: opts.db as any,
    entitiesTable: opts.tables.entities,
    membersTable: opts.tables.entityMembers,
    invitationsTable: opts.tables.entityInvitations,
    apiKeysTable: opts.tables.entityApiKeys,
    usersTable: opts.tables.users,
    keyPrefix: opts.entityKeyPrefix,
  };
  const entityHelpers = createEntityHelpers(config);

  /**
   * Look up an entity by slug and verify the user has appropriate permissions.
   *
   * When `requireEdit` is false, checks view access. When it is `true`, checks
   * if the user can create projects (i.e., has an admin/editor role). Pass a
   * permission name instead to require that specific permission -- for example
   * `"canManageApiKeys"` for routes that write credentials.
   *
   * @param entitySlug - The entity's URL-safe slug
   * @param actor - The requesting actor: a Firebase UID, or an `EntityActor`
   *   (use `getActor(c)` so entity API key requests are handled)
   * @param requireEdit - `true` for `canCreateProjects`, or a permission name (default: false)
   * @returns A discriminated union with either `{ entity }` or `{ error, errorCode }`
   */
  async function getEntityWithPermission(
    entitySlug: string,
    actor: string | EntityActor,
    requireEdit: boolean | keyof EntityPermissions = false
  ): Promise<EntityPermissionResult> {
    const resolved: EntityActor =
      typeof actor === "string" ? userActor(actor) : actor;

    const entity = await entityHelpers.entity.getEntityBySlug(entitySlug);
    if (!entity) {
      return { error: "Entity not found", errorCode: "ENTITY_NOT_FOUND" };
    }

    const required = requireEdit === true ? "canCreateProjects" : requireEdit;

    // An entity API key authenticates as the entity, so there is no membership to
    // consult: it is authorised exactly for the entity it was issued for.
    if (resolved.kind === "entity_api_key") {
      if (resolved.entityId !== entity.id) {
        return {
          error: "API key does not grant access to this entity",
          errorCode: "ACCESS_DENIED",
        };
      }
      if (required && !ENTITY_API_KEY_PERMISSIONS[required]) {
        return {
          error: "Insufficient permissions",
          errorCode: "INSUFFICIENT_PERMISSIONS",
        };
      }
      return { entity };
    }

    if (required) {
      const permissions = await entityHelpers.permissions.getUserPermissions(
        entity.id,
        resolved.userId
      );
      if (!permissions?.[required]) {
        return {
          error: "Insufficient permissions",
          errorCode: "INSUFFICIENT_PERMISSIONS",
        };
      }
    } else {
      const canView = await entityHelpers.permissions.canViewEntity(
        entity.id,
        resolved.userId
      );
      if (!canView) {
        return { error: "Access denied", errorCode: "ACCESS_DENIED" };
      }
    }

    return { entity };
  }

  return {
    entityHelpers,
    getEntityWithPermission,
    getActor,
    getPermissionErrorStatus,
  };
}

export type EntityAccess = ReturnType<typeof createEntityAccess>;

/**
 * Read the acting identity off a Hono context.
 *
 * Routes should pass this to `getEntityWithPermission` rather than a bare
 * `userId`, so requests authenticated with an entity API key are authorised as
 * the entity instead of being checked against a membership that does not exist.
 *
 * @param c - The Hono context, after `firebaseAuthMiddleware` has run
 */
export function getActor(c: Context): EntityActor {
  if (c.get("authMethod") === "entity_api_key") {
    return {
      kind: "entity_api_key",
      entityId: c.get("entityApiKeyEntityId"),
      keyId: c.get("entityApiKeyId"),
    };
  }
  return userActor(c.get("userId"));
}

/**
 * Determine the appropriate HTTP status code for a permission error.
 *
 * @param errorCode - The error code from `getEntityWithPermission()`
 * @returns 404 for not-found, 403 for access/permission errors
 */
export function getPermissionErrorStatus(errorCode: string): 400 | 403 | 404 {
  switch (errorCode) {
    case "ENTITY_NOT_FOUND":
      return 404;
    case "ACCESS_DENIED":
    case "INSUFFICIENT_PERMISSIONS":
      return 403;
    default:
      return 400;
  }
}
