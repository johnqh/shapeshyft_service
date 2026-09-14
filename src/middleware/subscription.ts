import type { Context } from "hono";
import { SubscriptionHelper } from "@sudobility/subscription_service";

export function createSubscriptionAccess(revenueCatApiKey: string | undefined) {
  let subscriptionHelper: SubscriptionHelper | null = null;

  /** Null when RevenueCat is not configured. */
  function getSubscriptionHelper(): SubscriptionHelper | null {
    if (!revenueCatApiKey) return null;
    if (!subscriptionHelper) {
      subscriptionHelper = new SubscriptionHelper({ revenueCatApiKey });
    }
    return subscriptionHelper;
  }

  function getTestMode(c: Context): boolean {
    const url = new URL(c.req.url);
    return url.searchParams.get("testMode") === "true";
  }

  return { getSubscriptionHelper, getTestMode };
}

export type SubscriptionAccess = ReturnType<typeof createSubscriptionAccess>;
