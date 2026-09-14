/**
 * @fileoverview Entity API key routes
 * @description CRUD for entity-scoped API keys ("<entity prefix>_...").
 *
 * A key authenticates a caller as the entity itself, so CI jobs, scripts, and
 * MCP clients keep working when the member who created them leaves. Storage is
 * hash-only: the plaintext appears once in the create response and is
 * unrecoverable afterwards -- a lost key is rotated, not revealed.
 *
 * Writes require `canManageApiKeys` (Owner or Manager); reads require
 * membership. Requests authenticated *with* an entity API key cannot reach
 * these routes at all -- see `assertNotEntityKeyAuth`.
 */

import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  entityApiKeyCreateSchema,
  entityApiKeyUpdateSchema,
  entityApiKeyIdParamSchema,
  entitySlugParamSchema,
} from "../schemas/index.js";
import {
  successResponse,
  errorResponse,
} from "@sudobility/shapeshyft_engine/types";
import type { ServiceContext } from "../context.js";

export function createEntityApiKeysRouter(ctx: ServiceContext) {
  const {
    entityHelpers,
    getActor,
    getEntityWithPermission,
    getPermissionErrorStatus,
  } = ctx.entityAccess;

  const entityApiKeysRouter = new Hono();

  /**
   * Refuse requests that authenticated with an entity API key.
   *
   * Letting a key mint or revoke keys would turn a single leaked credential into
   * permanent, self-renewing access. Key lifecycle stays with a human identity:
   * a Firebase token or a personal API key.
   *
   * @returns An error response to return, or null when the caller may proceed
   */
  function assertNotEntityKeyAuth(c: Context) {
    if (c.get("authMethod") === "entity_api_key") {
      return c.json(
        errorResponse(
          "Entity API keys cannot manage API keys. Sign in or use a personal API key."
        ),
        403
      );
    }
    return null;
  }

  /**
   * Guard against a misconfigured deployment.
   * `apiKeys` is present whenever `apiKeysTable` is configured, which it is here.
   */
  function requireApiKeyHelper(c: Context) {
    if (!entityHelpers.apiKeys) {
      return c.json(errorResponse("Entity API keys are not enabled"), 501);
    }
    return null;
  }

  // GET all API keys for an entity
  entityApiKeysRouter.get(
    "/",
    zValidator("param", entitySlugParamSchema),
    async c => {
      try {
        const unavailable = requireApiKeyHelper(c);
        if (unavailable) return unavailable;

        const { entitySlug } = c.req.valid("param");

        const result = await getEntityWithPermission(
          entitySlug,
          getActor(c),
          "canViewApiKeys"
        );
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        const keys = await entityHelpers.apiKeys!.getKeys(result.entity.id);
        return c.json(successResponse(keys));
      } catch (error: any) {
        console.error("Error listing entity API keys:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // POST create an API key -- the only response carrying the plaintext secret
  entityApiKeysRouter.post(
    "/",
    zValidator("param", entitySlugParamSchema),
    zValidator("json", entityApiKeyCreateSchema),
    async c => {
      try {
        const unavailable = requireApiKeyHelper(c);
        if (unavailable) return unavailable;

        const forbidden = assertNotEntityKeyAuth(c);
        if (forbidden) return forbidden;

        const userId = c.get("userId");
        const { entitySlug } = c.req.valid("param");
        const body = c.req.valid("json");

        const result = await getEntityWithPermission(
          entitySlug,
          getActor(c),
          "canManageApiKeys"
        );
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        const created = await entityHelpers.apiKeys!.createKey(
          result.entity.id,
          userId,
          body.key_name
        );

        return c.json(successResponse(created), 201);
      } catch (error: any) {
        console.error("Error creating entity API key:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // PUT rename a key or toggle whether it is active
  entityApiKeysRouter.put(
    "/:keyId",
    zValidator("param", entityApiKeyIdParamSchema),
    zValidator("json", entityApiKeyUpdateSchema),
    async c => {
      try {
        const unavailable = requireApiKeyHelper(c);
        if (unavailable) return unavailable;

        const forbidden = assertNotEntityKeyAuth(c);
        if (forbidden) return forbidden;

        const { entitySlug, keyId } = c.req.valid("param");
        const body = c.req.valid("json");

        const result = await getEntityWithPermission(
          entitySlug,
          getActor(c),
          "canManageApiKeys"
        );
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        const updated = await entityHelpers.apiKeys!.updateKey(
          result.entity.id,
          keyId,
          { keyName: body.key_name, isActive: body.is_active }
        );

        if (!updated) {
          return c.json(errorResponse("API key not found"), 404);
        }

        return c.json(successResponse(updated));
      } catch (error: any) {
        console.error("Error updating entity API key:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // DELETE revoke a key permanently
  entityApiKeysRouter.delete(
    "/:keyId",
    zValidator("param", entityApiKeyIdParamSchema),
    async c => {
      try {
        const unavailable = requireApiKeyHelper(c);
        if (unavailable) return unavailable;

        const forbidden = assertNotEntityKeyAuth(c);
        if (forbidden) return forbidden;

        const { entitySlug, keyId } = c.req.valid("param");

        const result = await getEntityWithPermission(
          entitySlug,
          getActor(c),
          "canManageApiKeys"
        );
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        const revoked = await entityHelpers.apiKeys!.revokeKey(
          result.entity.id,
          keyId
        );

        if (!revoked) {
          return c.json(errorResponse("API key not found"), 404);
        }

        return c.json(successResponse({ revoked: true }));
      } catch (error: any) {
        console.error("Error revoking entity API key:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  return entityApiKeysRouter;
}
