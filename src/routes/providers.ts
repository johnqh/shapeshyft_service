/**
 * @fileoverview Public provider catalog routes
 * @description Serves the LLM provider and model catalog. These are public
 * routes (no auth required) so the frontend can fetch provider/model info
 * without requiring server-side package updates.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  successResponse,
  errorResponse,
  type LlmProvider,
  type ProviderConfig,
  type ProviderModelsResponse,
} from "@sudobility/shapeshyft_engine/types";
import {
  PROVIDERS,
  PROVIDER_MODELS,
  MODEL_CAPABILITIES,
  MODEL_PRICING,
  DEFAULT_MODEL_PRICING,
  getProviderById,
} from "@sudobility/shapeshyft_engine";

export function createProvidersRouter() {
  const providersRouter = new Hono();

  // Schema for provider param validation
  const providerParamSchema = z.object({
    provider: z.string().min(1),
  });

  /**
   * GET /providers
   * Returns list of all available LLM providers with their configuration.
   * Cached for 1 hour since provider data is static.
   */
  providersRouter.get("/", async c => {
    try {
      c.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
      return c.json(
        successResponse<ProviderConfig[]>(PROVIDERS as ProviderConfig[])
      );
    } catch (error: unknown) {
      console.error("Error getting providers:", error);
      const message =
        error instanceof Error ? error.message : "Internal server error";
      return c.json(errorResponse(message), 500);
    }
  });

  /**
   * GET /providers/:provider
   * Returns configuration for a specific provider.
   * Cached for 1 hour since provider data is static.
   */
  providersRouter.get(
    "/:provider",
    zValidator("param", providerParamSchema),
    async c => {
      try {
        const { provider } = c.req.valid("param");
        const providerConfig = getProviderById(provider as LlmProvider);

        if (!providerConfig) {
          return c.json(errorResponse("Provider not found"), 404);
        }

        c.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
        return c.json(
          successResponse<ProviderConfig>(providerConfig as ProviderConfig)
        );
      } catch (error: unknown) {
        console.error("Error getting provider:", error);
        const message =
          error instanceof Error ? error.message : "Internal server error";
        return c.json(errorResponse(message), 500);
      }
    }
  );

  /**
   * GET /providers/:provider/models
   * Returns list of models for a provider with their capabilities and pricing.
   * Cached for 1 hour since model data is static.
   */
  providersRouter.get(
    "/:provider/models",
    zValidator("param", providerParamSchema),
    async c => {
      try {
        const { provider } = c.req.valid("param");
        const providerConfig = getProviderById(provider as LlmProvider);

        if (!providerConfig) {
          return c.json(errorResponse("Provider not found"), 404);
        }

        const modelIds = PROVIDER_MODELS[provider as LlmProvider] ?? [];

        // Build response with model details
        const models = modelIds.map(modelId => ({
          id: modelId,
          capabilities: MODEL_CAPABILITIES[modelId] ?? {},
          pricing: MODEL_PRICING[modelId] ?? DEFAULT_MODEL_PRICING,
        }));

        c.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
        const response: ProviderModelsResponse = {
          provider: providerConfig as ProviderConfig,
          models,
        };
        return c.json(successResponse<ProviderModelsResponse>(response));
      } catch (error: unknown) {
        console.error("Error getting provider models:", error);
        const message =
          error instanceof Error ? error.message : "Internal server error";
        return c.json(errorResponse(message), 500);
      }
    }
  );

  return providersRouter;
}
