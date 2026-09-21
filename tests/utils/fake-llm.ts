import type {
  createLLMProvider,
  LLMUsage,
  ProviderConfig,
} from "@sudobility/shapeshyft_engine";

export interface FakeLlmCall {
  provider: string;
  config: ProviderConfig;
}

/**
 * Records how providers were constructed; every generate() succeeds.
 * `usage` overrides the token counts each call reports.
 */
export function fakeLlm(
  calls: FakeLlmCall[],
  usage: LLMUsage = {
    promptTokens: 1000,
    completionTokens: 20,
    totalTokens: 1020,
  }
): typeof createLLMProvider {
  return ((provider, config) => {
    calls.push({ provider, config });
    return {
      providerName: provider,
      generate: async () => ({
        content: { label: "positive" },
        rawResponse: '{"label":"positive"}',
        usage,
        model: "gpt-4o-mini",
        provider,
        latencyMs: 5,
        finishReason: "stop",
      }),
      buildApiPayload: () => ({}),
    };
  }) as typeof createLLMProvider;
}
