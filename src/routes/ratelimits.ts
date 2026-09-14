/**
 * @fileoverview Rate limit configuration and usage history routes
 * @description Provides rate limit config (tiers, current usage) and
 * usage history per entity. Rate limits are tied to RevenueCat subscriptions.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  successResponse,
  errorResponse,
} from "@sudobility/shapeshyft_engine/types";
import {
  RateLimitPeriodType,
  type RateLimitsConfigData,
  type RateLimitHistoryData,
} from "@sudobility/types";
import type { ServiceContext } from "../context.js";

export function createRatelimitsRouter(ctx: ServiceContext) {
  const { db } = ctx;
  const { entities, entityMembers } = ctx.tables;
  const {
    getRateLimitRouteHandler,
    rateLimitsConfig,
    entitlementDisplayNames,
  } = ctx.rateLimiting;

  const ratelimitsRouter = new Hono();

  /**
   * Extract testMode from URL query parameter
   */
  function getTestMode(c: any): boolean {
    const url = new URL(c.req.url);
    const testMode = url.searchParams.get("testMode");
    return testMode === "true";
  }

  /**
   * Check if RevenueCat is configured
   */
  function isRevenueCatConfigured(): boolean {
    const key = ctx.revenueCatApiKey;
    return !!key && key.length > 0;
  }

  /**
   * Verify user has access to entity and return its ID.
   * rateLimitUserId is taken from path parameter (an entity slug).
   */
  async function getEntityIdForRateLimits(
    c: any,
    firebaseUid: string
  ): Promise<{ entityId: string | null; error: string | null }> {
    // rateLimitUserId is the entity slug
    const rateLimitUserId = c.req.param("rateLimitUserId");

    if (!rateLimitUserId) {
      return { entityId: null, error: "rateLimitUserId is required" };
    }

    // Look up entity by slug (rateLimitUserId is the entity slug)
    const entityRows = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_slug, rateLimitUserId));

    if (entityRows.length === 0) {
      return { entityId: null, error: "Entity not found" };
    }

    const entity = entityRows[0]!;

    // Verify user has access to this entity
    const memberRows = await db
      .select()
      .from(entityMembers)
      .where(eq(entityMembers.entity_id, entity.id));

    const isMember = memberRows.some(
      m => m.user_id === firebaseUid && m.is_active
    );
    if (!isMember) {
      return { entityId: null, error: "Access denied to entity" };
    }

    return { entityId: entity.id, error: null };
  }

  /**
   * GET /ratelimits/:rateLimitUserId
   * Returns rate limit configurations for all entitlement tiers
   * and the current entity's usage.
   * rateLimitUserId is the entity slug.
   * Query params:
   *   - testMode: Optional, set to "true" for sandbox mode.
   * Note: Firebase auth is applied at the admin routes level.
   */
  ratelimitsRouter.get("/", async c => {
    try {
      const testMode = getTestMode(c);

      // If RevenueCat is not configured, return static config without usage data
      if (!isRevenueCatConfigured()) {
        const noneLimits = rateLimitsConfig.none;
        // Convert flat config to tiers array format
        const tiers = Object.entries(rateLimitsConfig).map(
          ([entitlement, limits]) => ({
            entitlement,
            displayName: entitlementDisplayNames[entitlement] || entitlement,
            limits: {
              hourly: limits.hourly ?? null,
              daily: limits.daily ?? null,
              monthly: limits.monthly ?? null,
            },
          })
        );
        const fallback: RateLimitsConfigData = {
          tiers,
          currentEntitlement: "none",
          currentLimits: {
            hourly: noneLimits.hourly ?? null,
            daily: noneLimits.daily ?? null,
            monthly: noneLimits.monthly ?? null,
          },
          currentUsage: {
            hourly: 0,
            daily: 0,
            monthly: 0,
          },
        };
        return c.json(successResponse<RateLimitsConfigData>(fallback));
      }

      const userId = c.get("userId");

      // Get entity ID for rate limit lookup
      const { entityId, error: entityError } = await getEntityIdForRateLimits(
        c,
        userId
      );

      if (entityError || !entityId) {
        const status =
          entityError === "rateLimitUserId is required"
            ? 400
            : entityError === "Access denied to entity"
              ? 403
              : 404;
        return c.json(errorResponse(entityError || "Entity not found"), status);
      }

      // Use entity ID for rate limits (subscriptions are per-entity)
      // testMode is passed to the method to filter sandbox purchases
      const data = await getRateLimitRouteHandler().getRateLimitsConfigData(
        entityId,
        testMode
      );

      return c.json(successResponse<RateLimitsConfigData>(data));
    } catch (error) {
      console.error("Error fetching rate limits config:", error);
      return c.json(errorResponse("Failed to fetch rate limits"), 500);
    }
  });

  /**
   * GET /ratelimits/:rateLimitUserId/history/:periodType
   * Returns usage history for a specific period type.
   * rateLimitUserId is the entity slug.
   * periodType can be: hour, day, or month
   * Query params:
   *   - testMode: Optional, set to "true" for sandbox mode.
   */
  ratelimitsRouter.get("/history/:periodType", async c => {
    try {
      const testMode = getTestMode(c);
      const periodTypeParam = c.req.param("periodType");

      // Validate period type
      if (!["hour", "day", "month"].includes(periodTypeParam)) {
        return c.json(
          errorResponse(
            "Invalid period type. Must be one of: hour, day, month"
          ),
          400
        );
      }

      // If RevenueCat is not configured, return empty history
      if (!isRevenueCatConfigured()) {
        const emptyHistory: RateLimitHistoryData = {
          periodType: periodTypeParam as RateLimitPeriodType,
          entries: [],
          totalEntries: 0,
        };
        return c.json(successResponse<RateLimitHistoryData>(emptyHistory));
      }

      const periodType = periodTypeParam as RateLimitPeriodType;
      const userId = c.get("userId");

      // Get entity ID for rate limit lookup
      const { entityId, error: entityError } = await getEntityIdForRateLimits(
        c,
        userId
      );

      if (entityError || !entityId) {
        const status =
          entityError === "rateLimitUserId is required"
            ? 400
            : entityError === "Access denied to entity"
              ? 403
              : 404;
        return c.json(errorResponse(entityError || "Entity not found"), status);
      }

      // Use entity ID for rate limits (subscriptions are per-entity)
      // testMode is passed to the method to filter sandbox purchases
      const data = await getRateLimitRouteHandler().getRateLimitHistoryData(
        entityId,
        periodType,
        100, // default limit
        testMode
      );

      return c.json(successResponse<RateLimitHistoryData>(data));
    } catch (error) {
      console.error("Error fetching rate limit history:", error);
      return c.json(errorResponse("Failed to fetch rate limit history"), 500);
    }
  });

  return ratelimitsRouter;
}
