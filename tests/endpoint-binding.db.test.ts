import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { client, db, resetSchema, tables } from "./utils/db.js";
import { seedEntityWithProject } from "./utils/seed.js";
import { testApp } from "./utils/test-service.js";
import type { ProviderCredentialResolver } from "../src/contracts.js";

const KEY_A = "11111111-1111-4111-8111-111111111111";

describe("endpoints router: provider binding", () => {
  let slug: string;
  let projectId: string;
  let calls: Array<Parameters<ProviderCredentialResolver["bindEndpoint"]>[0]>;

  const resolver: ProviderCredentialResolver = {
    async bindEndpoint(args) {
      calls.push(args);
      if (args.body.provider === "refuse") {
        return { ok: false, status: 400, message: "provider not available" };
      }
      const provider = (args.body.provider ?? args.current?.provider) as
        "openai" | "anthropic";
      return {
        ok: true,
        provider,
        llmKeyId: provider === "openai" ? KEY_A : null,
      };
    },
    resolve: async () => {
      throw new Error("not used");
    },
  };

  beforeEach(async () => {
    await resetSchema();
    calls = [];
    const seeded = await seedEntityWithProject();
    slug = seeded.entity.entity_slug;
    projectId = seeded.project.uuid;
  });

  afterAll(async () => {
    await client.end();
  });

  const base = { endpoint_name: "classify", display_name: "Classify" };
  const url = () => `/api/v1/entities/${slug}/projects/${projectId}/endpoints`;
  const post = (body: unknown) =>
    testApp({ credentials: resolver }).request(url(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("returns a binding failure verbatim", async () => {
    const res = await post({ ...base, provider: "refuse" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "provider not available"
    );
    expect(await db.select().from(tables.endpoints)).toHaveLength(0);
  });

  it("persists the provider and llm_key_id the resolver returns", async () => {
    const res = await post({ ...base, provider: "openai" });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(tables.endpoints);
    expect(row!.provider).toBe("openai");
    expect(row!.llm_key_id).toBe(KEY_A);
    expect(calls[0]!.current).toBeUndefined();
  });

  it("rejects a create missing the app's binding field via zod", async () => {
    const res = await post(base);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("updates provider and llm_key_id when the binding changes", async () => {
    await post({ ...base, provider: "openai" });
    const [created] = await db.select().from(tables.endpoints);

    const res = await testApp({ credentials: resolver }).request(
      `${url()}/${created!.uuid}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      }
    );
    expect(res.status).toBe(200);

    const [updated] = await db
      .select()
      .from(tables.endpoints)
      .where(eq(tables.endpoints.uuid, created!.uuid));
    expect(updated!.provider).toBe("anthropic");
    expect(updated!.llm_key_id).toBeNull();
    expect(calls[1]!.current?.uuid).toBe(created!.uuid);
  });

  it("passes the current row when an update carries no binding field", async () => {
    await post({ ...base, provider: "openai" });
    const [created] = await db.select().from(tables.endpoints);

    await testApp({ credentials: resolver }).request(
      `${url()}/${created!.uuid}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "Renamed" }),
      }
    );

    const [updated] = await db.select().from(tables.endpoints);
    expect(updated!.display_name).toBe("Renamed");
    expect(updated!.provider).toBe("openai");
    expect(calls[1]!.body.provider).toBeUndefined();
    expect(calls[1]!.current?.provider).toBe("openai");
  });
});
