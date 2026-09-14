import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { client, db, resetSchema, tables } from "./utils/db.js";
import { seedEntityWithProject } from "./utils/seed.js";
import { testApp } from "./utils/test-service.js";
import { fakeLlm, type FakeLlmCall } from "./utils/fake-llm.js";
import {
  attachUsage,
  type createLLMProvider,
} from "@sudobility/shapeshyft_engine";
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

  it("returns and records the call's cost at sub-cent precision", async () => {
    const res = await invoke(resolverReturning(okCredential));
    const body = (await res.json()) as {
      data: { usage: { estimated_cost_cents: number } };
    };
    // Whole-cent rounding stored this call, like nearly every call, as 0.
    expect(body.data.usage.estimated_cost_cents).toBe(0.0162);
    const [row] = await analyticsRows();
    expect(row!.estimated_cost_micro_cents).toBe(16_200n);

    const analytics = await testApp({
      credentials: resolverReturning(okCredential),
      createProvider: fakeLlm(llmCalls),
    }).request(`/api/v1/entities/${slug}/analytics`);
    const totals = (await analytics.json()) as {
      data: { aggregate: { total_estimated_cost_cents: number } };
    };
    expect(totals.data.aggregate.total_estimated_cost_cents).toBeCloseTo(
      0.0162,
      6
    );
  });

  it("records the cost of a call whose answer could not be used", async () => {
    const failing = ((provider: string) => ({
      providerName: provider,
      generate: async () => {
        throw attachUsage(
          new Error("Model returned unparseable JSON"),
          { promptTokens: 1000, completionTokens: 20, totalTokens: 1020 },
          "gpt-4o-mini"
        );
      },
      buildApiPayload: () => ({}),
    })) as unknown as typeof createLLMProvider;

    const res = await testApp({
      credentials: resolverReturning(okCredential),
      createProvider: failing,
    }).request(`/api/v1/ai/${slug}/svc-project/classify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${projectApiKey}`,
      },
      body: JSON.stringify({ text: "great" }),
    });

    expect(res.status).toBe(500);
    const [row] = await analyticsRows();
    expect(row).toMatchObject({
      success: false,
      tokens_input: 1000,
      tokens_output: 20,
      estimated_cost_micro_cents: 16_200n,
    });
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
    expect(seen[0]!.usage).toEqual({
      promptTokens: 1000,
      completionTokens: 20,
    });
    // gpt-4o-mini: 1000 * $0.15/1M + 20 * $0.60/1M = 0.0162 cents
    expect(seen[0]!.providerCostMicroCents).toBe(16_200n);
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
