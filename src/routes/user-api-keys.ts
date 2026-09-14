/**
 * @fileoverview Personal API key routes
 * @description CRUD for the personal API keys (`<user prefix>...`) a user can present instead of a
 * Firebase ID token. Keys are scoped to a user (not an entity): a key carries
 * exactly the access its owner has, across every entity they belong to.
 *
 * Two operations hand back a usable secret — create and reveal — and both
 * deliberately require a Firebase ID token. A leaked key can therefore be used
 * to call the API, but not to mint further credentials or read sibling keys.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, and, desc } from "drizzle-orm";
import {
  successResponse,
  errorResponse,
} from "@sudobility/shapeshyft_engine/types";
import {
  apiKeyIdParamSchema,
  userApiKeyCreateSchema,
  userApiKeyUpdateSchema,
  userIdParamSchema,
} from "../schemas/index.js";
import type { ServiceContext } from "../context.js";

export function createUserApiKeysRouter(ctx: ServiceContext) {
  const { db } = ctx;
  const { userApiKeys } = ctx.tables;
  const {
    generateUserApiKey,
    hashUserApiKey,
    encryptUserApiKey,
    decryptUserApiKey,
  } = ctx.userApiKeys;
  const { invalidateUserApiKeyCache } = ctx.userApiKeyCache;

  const userApiKeysRouter = new Hono();

  // =============================================================================
  // Types
  // =============================================================================

  /** API key without the secret — safe to return in listings. */
  interface UserApiKeySafe {
    uuid: string;
    firebase_uid: string;
    key_name: string;
    key_prefix: string;
    is_active: boolean;
    last_used_at: string | null;
    created_at: string | null;
    updated_at: string | null;
  }

  /** Response for create: the only time the full key is returned unprompted. */
  interface UserApiKeyCreated extends UserApiKeySafe {
    api_key: string;
  }

  /** Response for reveal. */
  interface UserApiKeyRevealed {
    api_key: string;
  }

  // =============================================================================
  // Helpers
  // =============================================================================

  type UserApiKeyRow = typeof userApiKeys.$inferSelect;

  function toSafe(row: UserApiKeyRow): UserApiKeySafe {
    return {
      uuid: row.uuid,
      firebase_uid: row.firebase_uid,
      key_name: row.key_name,
      key_prefix: row.key_prefix,
      is_active: row.is_active,
      last_used_at: row.last_used_at?.toISOString() ?? null,
      created_at: row.created_at?.toISOString() ?? null,
      updated_at: row.updated_at?.toISOString() ?? null,
    };
  }

  /**
   * Verify the path userId matches the authenticated user.
   * Returns an error message when it does not.
   */
  function checkOwnership(c: any, userId: string): string | null {
    const authUserId = c.get("userId");
    return authUserId === userId
      ? null
      : "You can only manage your own API keys";
  }

  /** Operations that yield a usable secret require a real Firebase token. */
  function requireFirebaseAuth(c: any): string | null {
    return c.get("authMethod") === "api_key"
      ? "This operation requires a Firebase ID token. An API key cannot create or reveal API keys."
      : null;
  }

  // =============================================================================
  // Routes
  // =============================================================================

  /**
   * GET /users/:userId/api-keys
   * List the caller's API keys. Secrets are never included.
   */
  userApiKeysRouter.get(
    "/",
    zValidator("param", userIdParamSchema),
    async c => {
      try {
        const { userId } = c.req.valid("param");
        const ownershipError = checkOwnership(c, userId);
        if (ownershipError) return c.json(errorResponse(ownershipError), 403);

        const rows = await db
          .select()
          .from(userApiKeys)
          .where(eq(userApiKeys.firebase_uid, userId))
          .orderBy(desc(userApiKeys.created_at));

        return c.json(successResponse<UserApiKeySafe[]>(rows.map(toSafe)));
      } catch (error: unknown) {
        console.error("Error listing user API keys:", error);
        const message =
          error instanceof Error ? error.message : "Internal server error";
        return c.json(errorResponse(message), 500);
      }
    }
  );

  /**
   * POST /users/:userId/api-keys
   * Create a key. The full value is returned once, here.
   * Requires a Firebase ID token.
   */
  userApiKeysRouter.post(
    "/",
    zValidator("param", userIdParamSchema),
    zValidator("json", userApiKeyCreateSchema),
    async c => {
      try {
        const { userId } = c.req.valid("param");
        const { key_name } = c.req.valid("json");

        const ownershipError = checkOwnership(c, userId);
        if (ownershipError) return c.json(errorResponse(ownershipError), 403);

        const authError = requireFirebaseAuth(c);
        if (authError) return c.json(errorResponse(authError), 403);

        const { key, prefix } = generateUserApiKey();
        const { encrypted, iv } = encryptUserApiKey(key);

        const rows = await db
          .insert(userApiKeys)
          .values({
            firebase_uid: userId,
            key_name,
            key_hash: hashUserApiKey(key),
            key_prefix: prefix,
            encrypted_key: encrypted,
            encryption_iv: iv,
          })
          .returning();

        const created: UserApiKeyCreated = {
          ...toSafe(rows[0]!),
          api_key: key,
        };

        return c.json(successResponse<UserApiKeyCreated>(created), 201);
      } catch (error: unknown) {
        console.error("Error creating user API key:", error);
        const message = error instanceof Error ? error.message : "Bad request";
        return c.json(errorResponse(message), 400);
      }
    }
  );

  /**
   * GET /users/:userId/api-keys/:keyId
   * Metadata for one key. The secret is not included.
   */
  userApiKeysRouter.get(
    "/:keyId",
    zValidator("param", apiKeyIdParamSchema),
    async c => {
      try {
        const { userId, keyId } = c.req.valid("param");
        const ownershipError = checkOwnership(c, userId);
        if (ownershipError) return c.json(errorResponse(ownershipError), 403);

        const rows = await db
          .select()
          .from(userApiKeys)
          .where(
            and(
              eq(userApiKeys.firebase_uid, userId),
              eq(userApiKeys.uuid, keyId)
            )
          );

        if (rows.length === 0) {
          return c.json(errorResponse("API key not found"), 404);
        }

        return c.json(successResponse<UserApiKeySafe>(toSafe(rows[0]!)));
      } catch (error: unknown) {
        console.error("Error getting user API key:", error);
        const message =
          error instanceof Error ? error.message : "Internal server error";
        return c.json(errorResponse(message), 500);
      }
    }
  );

  /**
   * GET /users/:userId/api-keys/:keyId/reveal
   * Return the full key so its owner can copy it again.
   * Requires a Firebase ID token.
   */
  userApiKeysRouter.get(
    "/:keyId/reveal",
    zValidator("param", apiKeyIdParamSchema),
    async c => {
      try {
        const { userId, keyId } = c.req.valid("param");

        const ownershipError = checkOwnership(c, userId);
        if (ownershipError) return c.json(errorResponse(ownershipError), 403);

        const authError = requireFirebaseAuth(c);
        if (authError) return c.json(errorResponse(authError), 403);

        const rows = await db
          .select()
          .from(userApiKeys)
          .where(
            and(
              eq(userApiKeys.firebase_uid, userId),
              eq(userApiKeys.uuid, keyId)
            )
          );

        if (rows.length === 0) {
          return c.json(errorResponse("API key not found"), 404);
        }

        const row = rows[0]!;
        const apiKey = decryptUserApiKey(row.encrypted_key, row.encryption_iv);

        return c.json(successResponse<UserApiKeyRevealed>({ api_key: apiKey }));
      } catch (error: unknown) {
        console.error("Error revealing user API key:", error);
        const message =
          error instanceof Error ? error.message : "Internal server error";
        return c.json(errorResponse(message), 500);
      }
    }
  );

  /**
   * PUT /users/:userId/api-keys/:keyId
   * Rename a key or toggle it active. Deactivating takes effect immediately.
   */
  userApiKeysRouter.put(
    "/:keyId",
    zValidator("param", apiKeyIdParamSchema),
    zValidator("json", userApiKeyUpdateSchema),
    async c => {
      try {
        const { userId, keyId } = c.req.valid("param");
        const body = c.req.valid("json");

        const ownershipError = checkOwnership(c, userId);
        if (ownershipError) return c.json(errorResponse(ownershipError), 403);

        const existing = await db
          .select()
          .from(userApiKeys)
          .where(
            and(
              eq(userApiKeys.firebase_uid, userId),
              eq(userApiKeys.uuid, keyId)
            )
          );

        if (existing.length === 0) {
          return c.json(errorResponse("API key not found"), 404);
        }

        const rows = await db
          .update(userApiKeys)
          .set({
            key_name: body.key_name ?? existing[0]!.key_name,
            is_active: body.is_active ?? existing[0]!.is_active,
            updated_at: new Date(),
          })
          .where(eq(userApiKeys.uuid, keyId))
          .returning();

        // Drop the cached identity so a deactivation is not honored late.
        invalidateUserApiKeyCache(existing[0]!.key_hash);

        return c.json(successResponse<UserApiKeySafe>(toSafe(rows[0]!)));
      } catch (error: unknown) {
        console.error("Error updating user API key:", error);
        const message = error instanceof Error ? error.message : "Bad request";
        return c.json(errorResponse(message), 400);
      }
    }
  );

  /**
   * DELETE /users/:userId/api-keys/:keyId
   * Permanently revoke a key.
   */
  userApiKeysRouter.delete(
    "/:keyId",
    zValidator("param", apiKeyIdParamSchema),
    async c => {
      try {
        const { userId, keyId } = c.req.valid("param");
        const ownershipError = checkOwnership(c, userId);
        if (ownershipError) return c.json(errorResponse(ownershipError), 403);

        const rows = await db
          .delete(userApiKeys)
          .where(
            and(
              eq(userApiKeys.firebase_uid, userId),
              eq(userApiKeys.uuid, keyId)
            )
          )
          .returning();

        if (rows.length === 0) {
          return c.json(errorResponse("API key not found"), 404);
        }

        invalidateUserApiKeyCache(rows[0]!.key_hash);

        return c.json(successResponse<UserApiKeySafe>(toSafe(rows[0]!)));
      } catch (error: unknown) {
        console.error("Error deleting user API key:", error);
        const message = error instanceof Error ? error.message : "Bad request";
        return c.json(errorResponse(message), 400);
      }
    }
  );

  return userApiKeysRouter;
}
