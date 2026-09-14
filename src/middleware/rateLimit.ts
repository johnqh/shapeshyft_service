import type { Context, Next } from "hono";
import {
  createRateLimitMiddleware,
  RateLimitRouteHandler,
  type RateLimitsConfig,
} from "@sudobility/ratelimit_service";
import type { ServiceDb } from "../contracts.js";
import type { ServiceTables } from "../schema/tables.js";

/**
 * Default rate limit tiers
 *
 * - none: Free tier users (no subscription)
 * - bandwidth_dev: Users with dev bandwidth entitlement
 * - bandwidth_pro: Pro users with higher limits
 * - bandwidth_ultra: Enterprise users with unlimited access
 */
export const DEFAULT_RATE_LIMITS_CONFIG: RateLimitsConfig = {
  none: { hourly: 10, daily: 120, monthly: 1800 },
  bandwidth_dev: { hourly: 100, daily: 1200, monthly: 18000 },
  bandwidth_pro: { hourly: 800, daily: 10000, monthly: 150000 },
  bandwidth_ultra: { hourly: undefined, daily: undefined, monthly: undefined },
};

export const DEFAULT_ENTITLEMENT_DISPLAY_NAMES: Record<string, string> = {
  none: "Free",
  bandwidth_dev: "Developer",
  bandwidth_pro: "Pro",
  bandwidth_ultra: "Ultra",
};

export function createRateLimiting(opts: {
  db: ServiceDb;
  rateLimitCounters: ServiceTables["rateLimitCounters"];
  revenueCatApiKey: string | undefined;
  rateLimitsConfig: RateLimitsConfig;
  entitlementDisplayNames: Record<string, string>;
}) {
  const { rateLimitsConfig, entitlementDisplayNames } = opts;

  // Lazily initialized so a missing RevenueCat key fails on first use, not at boot
  let routeHandler: RateLimitRouteHandler | null = null;
  let middleware: ReturnType<typeof createRateLimitMiddleware> | null = null;

  function requireRevenueCatKey(): string {
    if (!opts.revenueCatApiKey) {
      throw new Error(
        "Required environment variable REVENUECAT_API_KEY is not set"
      );
    }
    return opts.revenueCatApiKey;
  }

  /** Extract testMode from URL query parameter to filter sandbox purchases. */
  function getTestMode(c: Context): boolean {
    const url = new URL(c.req.url);
    return url.searchParams.get("testMode") === "true";
  }

  /** The route handler for rate limit endpoints. */
  function getRateLimitRouteHandler(): RateLimitRouteHandler {
    if (!routeHandler) {
      routeHandler = new RateLimitRouteHandler({
        revenueCatApiKey: requireRevenueCatKey(),
        rateLimitsConfig,
        db: opts.db as any,
        rateLimitsTable: opts.rateLimitCounters as any,
        entitlementDisplayNames,
      });
    }
    return routeHandler;
  }

  function getMiddleware(): ReturnType<typeof createRateLimitMiddleware> {
    if (!middleware) {
      middleware = createRateLimitMiddleware({
        revenueCatApiKey: requireRevenueCatKey(),
        rateLimitsConfig,
        // Cast to any to avoid type conflicts between different drizzle-orm/hono
        // instances when using bun link for local development
        db: opts.db as any,
        rateLimitsTable: opts.rateLimitCounters as any,
        getUserId: (c: any) => {
          // Set by the auth middleware for every auth method
          const userId = c.get("userId");
          if (!userId) {
            throw new Error("Authenticated user not found in context");
          }
          return userId;
        },
        getTestMode: (c: any) => getTestMode(c),
      });
    }
    return middleware;
  }

  /** Rate limit middleware for endpoints that need it. */
  async function rateLimitHandler(c: Context, next: Next) {
    await getMiddleware()(c as any, next as any);
  }

  return {
    rateLimitsConfig,
    entitlementDisplayNames,
    getRateLimitRouteHandler,
    rateLimitHandler,
    getTestMode,
  };
}

export type RateLimiting = ReturnType<typeof createRateLimiting>;
