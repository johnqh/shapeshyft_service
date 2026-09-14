import { describe, it, expect } from "vitest";
import { offlineContext } from "../utils/fakes.js";
import { createProvidersRouter } from "../../src/routes/providers.js";
import { createProjectsRouter } from "../../src/routes/projects.js";
import { createAnalyticsRouter } from "../../src/routes/analytics.js";
import { createStorageRouter } from "../../src/routes/storage.js";
import { createSettingsRouter } from "../../src/routes/settings.js";
import { createUsersRouter } from "../../src/routes/users.js";
import { createUserApiKeysRouter } from "../../src/routes/user-api-keys.js";
import { createEntityApiKeysRouter } from "../../src/routes/entity-api-keys.js";
import { createEntitiesRouter } from "../../src/routes/entities.js";
import { createInvitationsRouter } from "../../src/routes/invitations.js";
import { createRatelimitsRouter } from "../../src/routes/ratelimits.js";

describe("router factories", () => {
  it("build without touching the database", () => {
    const ctx = offlineContext();
    for (const factory of [
      createProjectsRouter,
      createAnalyticsRouter,
      createStorageRouter,
      createSettingsRouter,
      createUsersRouter,
      createUserApiKeysRouter,
      createEntityApiKeysRouter,
      createEntitiesRouter,
      createInvitationsRouter,
      createRatelimitsRouter,
    ]) {
      expect(() => factory(ctx)).not.toThrow();
    }
  });

  it("serves the provider catalog", async () => {
    const res = await createProvidersRouter().request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });
});
