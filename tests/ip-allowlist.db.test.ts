import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { client, db, resetSchema, tables } from "./utils/db.js";
import { seedEntityWithProject } from "./utils/seed.js";
import { testApp } from "./utils/test-service.js";
import { fakeLlm } from "./utils/fake-llm.js";
import type { ProviderCredentialResolver } from "../src/contracts.js";

const ALLOWED = "203.0.113.10";

const resolver: ProviderCredentialResolver = {
  bindEndpoint: async () => {
    throw new Error("not used");
  },
  resolve: async () => ({ ok: true, provider: "openai", apiKey: "sk-test" }),
};

describe("ai router: endpoint IP allowlist", () => {
  let slug: string;
  let projectApiKey: string;
  let endpointId: string;

  beforeEach(async () => {
    await resetSchema();
    const seeded = await seedEntityWithProject();
    slug = seeded.entity.entity_slug;
    projectApiKey = seeded.projectApiKey;
    const [endpoint] = await db
      .insert(tables.endpoints)
      .values({
        project_id: seeded.project.uuid,
        endpoint_name: "classify",
        display_name: "Classify",
        http_method: "POST",
        provider: "openai",
        model: "gpt-4o-mini",
        ip_allowlist: [ALLOWED],
      })
      .returning();
    endpointId = endpoint!.uuid;
  });

  afterAll(async () => {
    await client.end();
  });

  function invoke(peer: string | null, headers: Record<string, string> = {}) {
    return testApp({
      credentials: resolver,
      createProvider: fakeLlm([]),
      getPeerAddress: () => peer,
    }).request(`/api/v1/ai/${slug}/svc-project/classify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${projectApiKey}`,
        ...headers,
      },
      body: JSON.stringify({ text: "hello" }),
    });
  }

  it("rejects a direct caller that forges X-Forwarded-For with an allowed IP", async () => {
    const res = await invoke("198.51.100.66", { "X-Forwarded-For": ALLOWED });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "IP address 198.51.100.66 is not allowed to access this endpoint"
    );
  });

  it("rejects a direct caller that forges X-Real-IP with an allowed IP", async () => {
    const res = await invoke("198.51.100.66", { "X-Real-IP": ALLOWED });
    expect(res.status).toBe(403);
  });

  it("allows a direct caller whose connection is from the allowed IP", async () => {
    const res = await invoke(ALLOWED);
    expect(res.status).toBe(200);
  });

  it("allows an allowed client forwarded by our own proxy", async () => {
    const res = await invoke("172.18.0.2", {
      "X-Forwarded-For": `6.6.6.6, ${ALLOWED}`,
    });
    expect(res.status).toBe(200);
  });

  it("rejects when the peer address is unknown, whatever the headers say", async () => {
    const res = await invoke(null, { "X-Forwarded-For": ALLOWED });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "IP address unknown is not allowed to access this endpoint"
    );
  });

  it("leaves endpoints without an allowlist open", async () => {
    await db
      .update(tables.endpoints)
      .set({ ip_allowlist: null })
      .where(eq(tables.endpoints.uuid, endpointId));
    const res = await invoke(null);
    expect(res.status).toBe(200);
  });
});
