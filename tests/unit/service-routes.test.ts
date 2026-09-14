import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createShapeshyftService } from "../../src/service.js";
import { offlineConfig } from "../utils/fakes.js";

describe("buildRoutes", () => {
  const service = createShapeshyftService(offlineConfig());

  it("serves /providers without auth", async () => {
    const res = await service.buildRoutes().request("/providers");
    expect(res.status).toBe(200);
  });

  it("guards admin routes with the auth middleware", async () => {
    const res = await service.buildRoutes().request("/users/me");
    expect(res.status).toBe(401);
  });

  it("mounts product routes before the shared /entities/:entitySlug routes", async () => {
    const routes = service.buildRoutes({
      authMiddleware: async (_c, next) => next(),
      mountAdmin: admin => {
        const sync = new Hono();
        sync.get("/", c => c.text("product route"));
        admin.route("/entities/self/providers", sync);
      },
    });
    const res = await routes.request("/entities/self/providers");
    expect(await res.text()).toBe("product route");
  });
});
