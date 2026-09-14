/**
 * @fileoverview Assemble the service: context, routers, and the /api/v1 route tree
 */

import { Hono, type MiddlewareHandler } from "hono";
import {
  buildContext,
  type ServiceContext,
  type ShapeshyftServiceConfig,
} from "./context.js";
import { createFirebaseAuthMiddleware } from "./middleware/firebaseAuth.js";
import { createAiRouter } from "./routes/ai.js";
import { createProvidersRouter } from "./routes/providers.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createEndpointsRouter } from "./routes/endpoints.js";
import { createAnalyticsRouter } from "./routes/analytics.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createRatelimitsRouter } from "./routes/ratelimits.js";
import { createEntitiesRouter } from "./routes/entities.js";
import { createInvitationsRouter } from "./routes/invitations.js";
import { createStorageRouter } from "./routes/storage.js";
import { createUsersRouter } from "./routes/users.js";
import { createUserApiKeysRouter } from "./routes/user-api-keys.js";
import { createEntityApiKeysRouter } from "./routes/entity-api-keys.js";

export interface BuildRoutesOptions {
  /** Replaces the Firebase/API-key middleware on admin routes (tests). */
  authMiddleware?: MiddlewareHandler;
  /**
   * Mount product routes on the authenticated admin app. Runs before the shared
   * admin routes, so a literal segment such as `/entities/self/...` is matched
   * before `/entities/:entitySlug` can claim it.
   */
  mountAdmin?: (admin: Hono) => void;
}

export interface ShapeshyftService {
  ctx: ServiceContext;
  routers: {
    ai: Hono;
    providers: Hono;
    projects: Hono;
    endpoints: Hono;
    analytics: Hono;
    settings: Hono;
    ratelimits: Hono;
    entities: Hono<any>;
    invitations: Hono<any>;
    storage: Hono;
    users: Hono;
    userApiKeys: Hono;
    entityApiKeys: Hono;
  };
  middleware: {
    firebaseAuth: MiddlewareHandler;
    rateLimit: MiddlewareHandler;
  };
  /** The route tree to mount at `/api/v1`. */
  buildRoutes(options?: BuildRoutesOptions): Hono;
}

export function createShapeshyftService(
  config: ShapeshyftServiceConfig
): ShapeshyftService {
  const ctx = buildContext(config);

  const routers = {
    ai: createAiRouter(ctx),
    providers: createProvidersRouter(),
    projects: createProjectsRouter(ctx),
    endpoints: createEndpointsRouter(ctx),
    analytics: createAnalyticsRouter(ctx),
    settings: createSettingsRouter(ctx),
    ratelimits: createRatelimitsRouter(ctx),
    entities: createEntitiesRouter(ctx),
    invitations: createInvitationsRouter(ctx),
    storage: createStorageRouter(ctx),
    users: createUsersRouter(ctx),
    userApiKeys: createUserApiKeysRouter(ctx),
    entityApiKeys: createEntityApiKeysRouter(ctx),
  };

  const firebaseAuth = createFirebaseAuthMiddleware(ctx);

  function buildRoutes(options: BuildRoutesOptions = {}): Hono {
    const routes = new Hono();

    // Public routes (no auth) -- registered before the admin wildcard
    routes.route("/ai", routers.ai);
    routes.route("/providers", routers.providers);

    const admin = new Hono();
    admin.use("*", options.authMiddleware ?? firebaseAuth);
    options.mountAdmin?.(admin);
    admin.route("/entities/:entitySlug/api-keys", routers.entityApiKeys);
    admin.route("/entities/:entitySlug/storage", routers.storage);
    admin.route("/entities/:entitySlug/projects", routers.projects);
    admin.route(
      "/entities/:entitySlug/projects/:projectId/endpoints",
      routers.endpoints
    );
    admin.route("/entities/:entitySlug/analytics", routers.analytics);
    admin.route("/ratelimits/:rateLimitUserId", routers.ratelimits);
    admin.route("/users/:userId/settings", routers.settings);
    admin.route("/users/:userId/api-keys", routers.userApiKeys);
    admin.route("/entities", routers.entities);
    admin.route("/invitations", routers.invitations);
    admin.route("/users", routers.users);
    routes.route("/", admin);

    return routes;
  }

  return {
    ctx,
    routers,
    middleware: {
      firebaseAuth,
      rateLimit: ctx.rateLimiting.rateLimitHandler,
    },
    buildRoutes,
  };
}
