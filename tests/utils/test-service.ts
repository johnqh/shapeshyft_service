import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { db, tables } from "./db.js";
import { offlineConfig } from "./fakes.js";
import { TEST_UID } from "./seed.js";
import { createShapeshyftService } from "../../src/service.js";
import type { ShapeshyftServiceConfig } from "../../src/context.js";

export const fakeAuth: MiddlewareHandler = async (c, next) => {
  c.set("userId", TEST_UID);
  c.set("userEmail", "service-test@example.com");
  c.set("siteAdmin", false);
  c.set("authMethod", "firebase");
  await next();
};

/** A full /api/v1 app on the test schema, with fake auth. */
export function testApp(overrides: Partial<ShapeshyftServiceConfig>) {
  const service = createShapeshyftService({
    ...offlineConfig(),
    db: db as any,
    tables,
    endpointBinding: {
      create: { provider: z.string() },
      update: { provider: z.string().optional() },
    },
    ...overrides,
  });
  const app = new Hono();
  app.route("/api/v1", service.buildRoutes({ authMiddleware: fakeAuth }));
  return app;
}
