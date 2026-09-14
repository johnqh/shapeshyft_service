import type {
  createLLMProvider,
  ProviderConfig,
} from "@sudobility/shapeshyft_engine";

export interface FakeLlmCall {
  provider: string;
  config: ProviderConfig;
}

/** Records how providers were constructed; every generate() succeeds. */
export function fakeLlm(calls: FakeLlmCall[]): typeof createLLMProvider {
  return ((provider, config) => {
    calls.push({ provider, config });
    return {
      providerName: provider,
      generate: async () => ({
        content: { label: "positive" },
        rawResponse: '{"label":"positive"}',
        usage: { promptTokens: 1000, completionTokens: 20, totalTokens: 1020 },
        model: "gpt-4o-mini",
        provider,
        latencyMs: 5,
        finishReason: "stop",
      }),
      buildApiPayload: () => ({}),
    };
  }) as typeof createLLMProvider;
}
