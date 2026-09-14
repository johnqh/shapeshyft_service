/**
 * @fileoverview User routes
 */

import { Hono } from "hono";
import {
  type BackendSubscriptionResult,
  NONE_ENTITLEMENT,
  type UserInfoResponse,
} from "@sudobility/types";
import {
  successResponse,
  errorResponse,
} from "@sudobility/shapeshyft_engine/types";
import type { AuthAdapter } from "../contracts.js";
import type { ServiceContext } from "../context.js";

export function createUsersRouter(ctx: ServiceContext) {
  const getUserInfo: AuthAdapter["getUserInfo"] = (...args) =>
    ctx.auth.getUserInfo(...args);
  const { getSubscriptionHelper, getTestMode } = ctx.subscription;

  const usersRouter = new Hono();

  /**
   * GET /users/:userId
   *
   * Get user information including siteAdmin status.
   * Requires the Firebase token to match the requested userId.
   * Returns 403 if token doesn't match or user not found.
   *
   * Note: This route is under adminRoutes which applies firebaseAuthMiddleware,
   * so c.get("userId") is already available.
   */
  /**
   * GET /users/me
   *
   * Identify the authenticated caller. Works with either auth method, and is the
   * only way an API-key client can learn its own Firebase UID — which the
   * /users/:userId/* routes require. Registered before "/:userId" so the literal
   * "me" is not captured as a user id.
   */
  usersRouter.get("/me", async c => {
    const userId = c.get("userId");
    const userEmail = c.get("userEmail");

    // The display name is a nicety fetched from Firebase. Identity is already
    // established by the middleware, so a Firebase outage (or an API-key caller on
    // a deployment without Firebase reachable) must not fail this route.
    let displayName: string | null = null;
    try {
      const userInfo = await getUserInfo(userId);
      displayName = userInfo?.displayName ?? null;
    } catch (error) {
      console.error("Could not load Firebase profile for /users/me:", error);
    }

    return c.json(
      successResponse({
        firebase_uid: userId,
        email: userEmail,
        siteAdmin: c.get("siteAdmin") ?? false,
        auth_method: c.get("authMethod") ?? "firebase",
        display_name: displayName,
      })
    );
  });

  usersRouter.get("/:userId", async c => {
    const requestedUserId = c.req.param("userId");
    const tokenUserId = c.get("userId");

    // Verify the token belongs to the requested user
    if (requestedUserId !== tokenUserId) {
      return c.json(errorResponse("Token does not match requested user"), 403);
    }

    const userInfo = await getUserInfo(requestedUserId);

    if (!userInfo) {
      return c.json(errorResponse("User not found"), 403);
    }

    return c.json(successResponse<UserInfoResponse>(userInfo));
  });

  /**
   * GET /users/:userId/subscriptions
   *
   * Get user subscription status (requires Firebase auth).
   */
  usersRouter.get("/:userId/subscriptions", async c => {
    const requestedUserId = c.req.param("userId");
    const tokenUserId = c.get("userId");

    if (requestedUserId !== tokenUserId) {
      return c.json(
        errorResponse("You can only access your own subscription"),
        403
      );
    }

    const subHelper = getSubscriptionHelper();
    if (!subHelper) {
      return c.json(errorResponse("Subscription service not configured"), 500);
    }

    try {
      const testMode = getTestMode(c);
      const subscriptionInfo = await subHelper.getSubscriptionInfo(
        requestedUserId,
        testMode
      );
      const subscriptionResult: BackendSubscriptionResult = {
        hasSubscription:
          subscriptionInfo.entitlements.length > 0 &&
          !subscriptionInfo.entitlements.includes(NONE_ENTITLEMENT),
        entitlements: subscriptionInfo.entitlements,
        subscriptionStartedAt:
          subscriptionInfo.subscriptionStartedAt?.toISOString() ?? null,
        platform: subscriptionInfo.platform,
        productIdentifier: subscriptionInfo.productIdentifier,
        expiresDate: subscriptionInfo.expiresDate?.toISOString() ?? null,
        willRenew: subscriptionInfo.willRenew,
        managementUrl: subscriptionInfo.managementUrl,
      };
      return c.json(
        successResponse<BackendSubscriptionResult>(subscriptionResult)
      );
    } catch (error) {
      console.error("Error fetching subscription:", error);
      return c.json(errorResponse("Failed to fetch subscription status"), 500);
    }
  });

  return usersRouter;
}
