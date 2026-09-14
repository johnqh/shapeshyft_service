import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createFirebaseAuthMiddleware } from "../../src/middleware/firebaseAuth.js";
import { offlineContext } from "../utils/fakes.js";

function appWith(prefixes: { user: string; entity: string }) {
  const app = new Hono();
  app.use(
    "*",
    createFirebaseAuthMiddleware(offlineContext({ keyPrefixes: prefixes }))
  );
  app.get("/users/me", c => c.text("ok"));
  return app;
}

describe("firebaseAuth middleware with injected prefixes", () => {
  it("names the configured prefixes in the 401 message", async () => {
    const res = await appWith({
      user: "shroute_",
      entity: "shrouteent",
    }).request("/users/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("'X-API-Key: shroute_...'");
    expect(body.error).toContain("'X-API-Key: shrouteent_...'");
  });

  it("keeps ShapeShyft's exact 401 message", async () => {
    const res = await appWith({ user: "shyft_", entity: "shyftent" }).request(
      "/users/me"
    );
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "Authorization required. Provide a Firebase ID token as 'Authorization: Bearer <token>', a personal API key as 'X-API-Key: shyft_...', or an entity API key as 'X-API-Key: shyftent_...'"
    );
  });

  it("treats another product's personal key as no credential", async () => {
    const res = await appWith({ user: "shyft_", entity: "shyftent" }).request(
      "/users/me",
      { headers: { "X-API-Key": "shroute_abcdef" } }
    );
    // Not recognised as a key (no DB lookup), no Authorization header -> 401.
    expect(res.status).toBe(401);
  });

  it("rejects an invalid Firebase token", async () => {
    const res = await appWith({ user: "shyft_", entity: "shyftent" }).request(
      "/users/me",
      { headers: { Authorization: "Bearer not-a-token" } }
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Invalid or expired Firebase token"
    );
  });
});
