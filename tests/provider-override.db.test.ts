import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { client, db, resetSchema, tables } from "./utils/db.js";
import { seedEntityWithProject } from "./utils/seed.js";
import { testApp } from "./utils/test-service.js";
import { fakeLlm, type FakeLlmCall } from "./utils/fake-llm.js";
import {
  ApiHelper,
  buildProviderRequest,
  type LLMRequest,
} from "@sudobility/shapeshyft_engine";
import type {
  AiPromptResponse,
  LlmProvider,
} from "@sudobility/shapeshyft_engine/types";
import type {
  ProviderCredentialResolver,
  ResolvedCredential,
} from "../src/contracts.js";

/**
 * `llm_provider` / `llm_model`: a call-time provider override. Invoke runs on
 * the entity's key for that provider; /prompt describes the provider request
 * without needing any key.
 */
describe("ai router: llm_provider override", () => {
  let slug: string;
  let projectApiKey: string;
  let llmCalls: FakeLlmCall[];
  let llmRequests: LLMRequest[];
  let resolveCalls: Array<{ entityId: string; provider?: LlmProvider }>;

  const schema = {
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
  };

  /** Resolves the bound key (openai) or, when asked, a key for `provider`. */
  function resolver(
    answer?: (provider: LlmProvider) => ResolvedCredential | null
  ): ProviderCredentialResolver {
    return {
      bindEndpoint: async () => {
        throw new Error("not used");
      },
      resolve: async ({ entityId, provider }) => {
        resolveCalls.push({ entityId, ...(provider ? { provider } : {}) });
        if (!provider) {
          return { ok: true, provider: "openai", apiKey: "sk-bound" };
        }
        const found = answer
          ? answer(provider)
          : { ok: true as const, provider, apiKey: `sk-${provider}` };
        return (
          found ?? {
            ok: false,
            status: 400,
            message: `No active ${provider} API key for this organization`,
          }
        );
      },
    };
  }

  function call(
    credentials: ProviderCredentialResolver,
    body: Record<string, unknown>,
    path = ""
  ) {
    return testApp({
      credentials,
      createProvider: fakeLlm(llmCalls, undefined, llmRequests),
    }).request(`/api/v1/ai/${slug}/svc-project/classify${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${projectApiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    await resetSchema();
    llmCalls = [];
    llmRequests = [];
    resolveCalls = [];
    const seeded = await seedEntityWithProject();
    slug = seeded.entity.entity_slug;
    projectApiKey = seeded.projectApiKey;
    await db.insert(tables.endpoints).values({
      project_id: seeded.project.uuid,
      endpoint_name: "classify",
      display_name: "Classify",
      http_method: "POST",
      provider: "openai",
      model: "gpt-4o-mini",
      instructions: "Classify the sentiment",
      output_schema: schema,
      max_output_tokens: 800,
    });
  });

  afterAll(async () => {
    await client.end();
  });

  describe("invoke", () => {
    it("runs on the entity's key for the named provider and model", async () => {
      const res = await call(resolver(), {
        text: "great",
        llm_provider: "anthropic",
        llm_model: "claude-haiku-4-5",
      });
      expect(res.status).toBe(200);
      expect(resolveCalls).toEqual([
        { entityId: expect.any(String), provider: "anthropic" },
      ]);
      expect(llmCalls[0]!.provider).toBe("anthropic");
      expect(llmCalls[0]!.config.apiKey).toBe("sk-anthropic");
      expect(llmRequests[0]!.model).toBe("claude-haiku-4-5");
      // Reserved: never reaches the prompt
      expect(llmRequests[0]!.prompt).not.toContain("llm_provider");
      expect(llmRequests[0]!.prompt).not.toContain("claude-haiku-4-5");
    });

    it("uses the catalog default model when llm_model is omitted", async () => {
      await call(resolver(), { text: "great", llm_provider: "deepseek" });
      expect(llmRequests[0]!.model).toBe("deepseek-flash");
    });

    it("keeps the old behaviour without llm_provider", async () => {
      await call(resolver(), { text: "great", llm_model: "gpt-5.4" });
      expect(resolveCalls).toEqual([{ entityId: expect.any(String) }]);
      expect(llmCalls[0]!.provider).toBe("openai");
      expect(llmRequests[0]!.model).toBe("gpt-4o-mini");
    });

    it("rejects an unknown provider id with 400", async () => {
      const res = await call(resolver(), {
        text: "great",
        llm_provider: "chatgpt",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /Invalid llm_provider "chatgpt"/
      );
      expect(resolveCalls).toHaveLength(0);
      expect(llmCalls).toHaveLength(0);
    });

    it("returns the resolver's 400 when the entity has no such key", async () => {
      const res = await call(
        resolver(() => null),
        { text: "great", llm_provider: "openrouter" }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "No active openrouter API key for this organization"
      );
      expect(llmCalls).toHaveLength(0);
    });

    it("refuses a credential for another provider", async () => {
      const res = await call(
        resolver(() => ({ ok: true, provider: "openai", apiKey: "sk-x" })),
        { text: "great", llm_provider: "anthropic" }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "No active anthropic API key for this organization"
      );
      expect(llmCalls).toHaveLength(0);
    });
  });

  describe("/prompt", () => {
    async function promptData(res: Response): Promise<AiPromptResponse> {
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: AiPromptResponse }).data;
    }

    it("returns only the prompt without llm_provider, as before", async () => {
      const data = await promptData(
        await call(resolver(), { text: "great" }, "/prompt")
      );
      expect(typeof data.prompt).toBe("string");
      expect(data).not.toHaveProperty("request");
      expect(resolveCalls).toHaveLength(1);
    });

    it("describes the OpenAI request invoke would send, without any key", async () => {
      const data = await promptData(
        await call(
          resolver(),
          { text: "great", llm_provider: "openai", llm_model: "gpt-5.4" },
          "/prompt"
        )
      );
      // No key needed, so nothing was resolved
      expect(resolveCalls).toHaveLength(0);
      expect(typeof data.prompt).toBe("string");
      expect(data.prompt).not.toContain("llm_provider");

      const prompts = ApiHelper.buildLegacyPrompts({
        inputData: { text: "great" },
        outputSchema: schema as never,
        instructions: "Classify the sentiment",
        context: null,
        provider: "openai",
      });
      const expected = buildProviderRequest({
        provider: "openai",
        model: "gpt-5.4",
        systemPrompt: prompts.system,
        prompt: prompts.user,
        outputSchema: schema as never,
        maxTokens: 800,
      });
      expect(data.request).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(data.request).toMatchObject({
        provider: "openai",
        model: "gpt-5.4",
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        auth: { header: "Authorization", prefix: "Bearer " },
      });
      expect(data.request!.body.max_completion_tokens).toBe(800);
      expect(JSON.stringify(data)).not.toContain("sk-");
    });

    it("matches what invoke sends for the same input", async () => {
      const body = {
        text: "great",
        llm_provider: "anthropic",
        llm_model: "claude-sonnet-5",
      };
      const data = await promptData(await call(resolver(), body, "/prompt"));
      await call(resolver(), body);
      const sent = llmRequests[0]!;
      expect(data.request!.body).toEqual(
        JSON.parse(
          JSON.stringify(
            buildProviderRequest({ ...sent, provider: "anthropic" }).body
          )
        )
      );
      expect(data.request!.auth).toEqual({ header: "x-api-key", prefix: "" });
      expect(data.request!.headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("describes OpenRouter at its own URL", async () => {
      const data = await promptData(
        await call(
          resolver(),
          { text: "great", llm_provider: "openrouter" },
          "/prompt"
        )
      );
      expect(data.request!.url).toBe(
        "https://openrouter.ai/api/v1/chat/completions"
      );
      expect(data.request!.model).toBe("openai/gpt-5.6-terra");
    });

    it("rejects an unknown provider id with 400", async () => {
      const res = await call(
        resolver(),
        { text: "great", llm_provider: "nope" },
        "/prompt"
      );
      expect(res.status).toBe(400);
    });

    it("rejects a provider it cannot describe with 400", async () => {
      const res = await call(
        resolver(),
        { text: "great", llm_provider: "gemini" },
        "/prompt"
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /does not support provider "gemini"/
      );
    });
  });
});
