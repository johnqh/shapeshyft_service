import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { client, db, resetSchema, tables } from "./utils/db.js";
import { seedEntityWithProject } from "./utils/seed.js";
import { testApp } from "./utils/test-service.js";
import { fakeLlm, type FakeLlmCall } from "./utils/fake-llm.js";
import type {
  InvokeHooks,
  ProviderCredentialResolver,
  ResolvedCredential,
  ResolverFailure,
} from "../src/contracts.js";

describe("ai router: credential resolution and hooks", () => {
  let slug: string;
  let projectApiKey: string;
  let endpointId: string;
  let llmCalls: FakeLlmCall[];

  function resolverReturning(
    result: ResolvedCredential | ResolverFailure
  ): ProviderCredentialResolver {
    return {
      bindEndpoint: async () => {
        throw new Error("not used");
      },
      resolve: async () => result,
    };
  }

  const okCredential: ResolvedCredential = {
    ok: true,
    provider: "anthropic",
    apiKey: "sk-resolved",
    timeoutMs: 42_000,
  };

  function invoke(
    credentials: ProviderCredentialResolver,
    hooks?: InvokeHooks,
    path = ""
  ) {
    return testApp({
      credentials,
      hooks,
      createProvider: fakeLlm(llmCalls),
    }).request(`/api/v1/ai/${slug}/svc-project/classify${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${projectApiKey}`,
      },
      body: JSON.stringify({ text: "great" }),
    });
  }

  const analyticsRows = () =>
    db
      .select()
      .from(tables.usageAnalytics)
      .where(eq(tables.usageAnalytics.endpoint_id, endpointId));

  beforeEach(async () => {
    await resetSchema();
    llmCalls = [];
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
      })
      .returning();
    endpointId = endpoint!.uuid;
  });

  afterAll(async () => {
    await client.end();
  });

  it("returns a resolver failure verbatim and never builds a provider", async () => {
    const res = await invoke(
      resolverReturning({
        ok: false,
        status: 503,
        message: "provider_unavailable: openai",
      })
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(
      "provider_unavailable: openai"
    );
    expect(llmCalls).toHaveLength(0);
  });

  it("builds the provider from the resolved credential, not the column", async () => {
    const res = await invoke(resolverReturning(okCredential));
    expect(res.status).toBe(200);
    expect(llmCalls).toEqual([
      {
        provider: "anthropic",
        config: {
          apiKey: "sk-resolved",
          endpointUrl: undefined,
          timeoutMs: 42_000,
        },
      },
    ]);
  });

  it("records analytics with a plain insert when no hooks are configured", async () => {
    await invoke(resolverReturning(okCredential));
    const rows = await analyticsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.success).toBe(true);
  });

  it("stops the request with beforeInvoke's Response", async () => {
    const res = await invoke(resolverReturning(okCredential), {
      beforeInvoke: async () =>
        new Response(JSON.stringify({ error: "insufficient_credit" }), {
          status: 402,
          headers: { "Content-Type": "application/json" },
        }),
    });
    expect(res.status).toBe(402);
    expect(llmCalls).toHaveLength(0);
    expect(await analyticsRows()).toHaveLength(0);
  });

  it("gives afterInvoke the committed analytics row and micro-cent cost", async () => {
    const seen: Parameters<NonNullable<InvokeHooks["afterInvoke"]>>[0][] = [];
    const res = await invoke(resolverReturning(okCredential), {
      afterInvoke: async args => {
        seen.push(args);
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.provider).toBe("anthropic");
    expect(seen[0]!.usage).toEqual({ promptTokens: 1000, completionTokens: 20 });
    expect(typeof seen[0]!.providerCostMicroCents).toBe("bigint");
    const rows = await analyticsRows();
    expect(rows.map(r => r.uuid)).toEqual([seen[0]!.usageAnalyticsId]);
  });

  it("rolls the analytics row back when afterInvoke throws", async () => {
    const res = await invoke(resolverReturning(okCredential), {
      afterInvoke: async () => {
        throw new Error("ledger write failed");
      },
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Failed to record usage for this call"
    );
    expect(await analyticsRows()).toHaveLength(0);
  });

  it("resolves but runs no hooks for /prompt", async () => {
    let hookRan = false;
    const res = await invoke(
      resolverReturning(okCredential),
      {
        beforeInvoke: async () => {
          hookRan = true;
        },
      },
      "/prompt"
    );
    expect(res.status).toBe(200);
    expect(hookRan).toBe(false);
    expect(llmCalls).toHaveLength(0);
  });
});
