/**
 * @fileoverview Public AI inference routes
 * @description Handles AI endpoint invocation and prompt generation.
 * These routes use project API key authentication (not Firebase),
 * with optional IP allowlisting and rate limiting per entity.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, and, sql } from "drizzle-orm";
import { aiParamSchema } from "../schemas/index.js";
import {
  successResponse,
  errorResponse,
  type JsonSchema,
  type AiExecutionResponse,
  type AiPromptResponse,
} from "@sudobility/shapeshyft_engine/types";
import {
  ApiHelper,
  estimateCost,
  getModelPricing,
  type LLMRequest,
  extractMediaFromInput,
  convertAllMediaIfNeeded,
  validateMediaCapabilities,
  validateWhisperRequest,
  isTranscriptionModel,
  extractReservedFields,
  resolveMaxOutputTokens,
} from "@sudobility/shapeshyft_engine";
import {
  EntitlementHelper,
  RateLimitChecker,
} from "@sudobility/ratelimit_service";
import { SubscriptionHelper } from "@sudobility/subscription_service";
import type { ServiceContext } from "../context.js";
import type {
  EndpointRow,
  EntityRow,
  ProjectRow,
  ResolvedCredential,
} from "../contracts.js";
import { toMicroCents } from "../lib/money.js";
import { resolveAllowlistIp } from "../lib/client-ip.js";

export function createAiRouter(ctx: ServiceContext) {
  const { db } = ctx;
  const {
    projects,
    endpoints,
    usageAnalytics,
    entities,
    entityMembers,
    users,
    rateLimitCounters,
  } = ctx.tables;
  const { validateProjectApiKey, isValidApiKeyFormat } = ctx.projectApiKeys;

  const aiRouter = new Hono();

  /**
   * Record one invocation against the endpoint's lifetime counter.
   *
   * Incremented in SQL rather than read-modify-write so concurrent calls to the
   * same endpoint cannot lose counts. Best-effort: a failure here is logged and
   * swallowed, because losing a tally must never fail a request the caller
   * already paid for.
   *
   * @param endpointId - UUID of the endpoint that was called
   */
  async function incrementCallCount(endpointId: string): Promise<void> {
    try {
      await db
        .update(endpoints)
        .set({ call_count: sql`${endpoints.call_count} + 1` })
        .where(eq(endpoints.uuid, endpointId));
    } catch (error) {
      ctx.logger.error("Failed to increment endpoint call count:", error);
    }
  }

  // =============================================================================
  // Types
  // =============================================================================

  interface ValidatedContext {
    success: true;
    entity: EntityRow;
    project: ProjectRow;
    endpoint: EndpointRow;
    /** The app-resolved credential; its provider is authoritative for the call */
    credential: ResolvedCredential;
    inputData: unknown;
  }

  interface ValidationError {
    success: false;
    response: Response;
  }

  type ValidationResult = ValidatedContext | ValidationError;

  // =============================================================================
  // Security Helpers
  // =============================================================================

  /**
   * Extract API key from request (query param or Authorization header)
   */
  function extractApiKey(c: any): string | null {
    // 1. Check query parameter
    const url = new URL(c.req.url);
    const queryKey = url.searchParams.get("api_key");
    if (queryKey) {
      return queryKey;
    }

    // 2. Check Authorization header (Bearer token)
    const authHeader = c.req.header("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.substring(7);
    }

    return null;
  }

  /**
   * The caller's IP, for the endpoint allowlist.
   *
   * Forwarded headers are believed only when the connection itself comes from a
   * private address -- our own proxy. A caller that connects directly is judged
   * by its connection, so it cannot name an allowlisted address in a header.
   * Null (deny) when the runtime cannot report the peer.
   */
  function getClientIp(c: any): string | null {
    let peer: string | null | undefined;
    try {
      peer = ctx.getPeerAddress(c);
    } catch {
      peer = null;
    }
    return resolveAllowlistIp(peer, name => c.req.header(name));
  }

  /**
   * Check if IP is in the allowlist
   */
  function isIpAllowed(
    clientIp: string | null,
    allowlist: string[] | null
  ): boolean {
    // If no allowlist is set, allow all
    if (!allowlist || allowlist.length === 0) {
      return true;
    }

    // If allowlist is set but no client IP, deny
    if (!clientIp) {
      return false;
    }

    return allowlist.includes(clientIp);
  }

  // =============================================================================
  // Input Processing Helpers
  // =============================================================================

  // Reserved input fields (context, web_search, max_output_tokens) are pulled out
  // by extractReservedFields in ../lib/reserved-fields.

  // =============================================================================
  // Shared Validation Logic
  // =============================================================================

  /**
   * Find entity by slug (organization path).
   * The organization path in the public API URL is now the entity slug.
   */
  async function findEntityBySlug(
    entitySlug: string
  ): Promise<EntityRow | null> {
    const entityRows = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_slug, entitySlug));

    return entityRows[0] ?? null;
  }

  // Lazy-initialized rate limit helpers
  let _subscriptionHelper: SubscriptionHelper | null = null;
  let _entitlementHelper: EntitlementHelper | null = null;
  let _rateLimitChecker: RateLimitChecker | null = null;

  /**
   * Get subscription helper (singleton, lazily initialized).
   * Uses single API key - testMode is passed to getSubscriptionInfo to filter sandbox purchases.
   */
  function getSubscriptionHelper(): SubscriptionHelper | null {
    const apiKey = ctx.revenueCatApiKey;
    if (!apiKey) return null;
    if (!_subscriptionHelper) {
      _subscriptionHelper = new SubscriptionHelper({
        revenueCatApiKey: apiKey,
      });
    }
    return _subscriptionHelper;
  }

  function getEntitlementHelper(): EntitlementHelper {
    if (!_entitlementHelper) {
      _entitlementHelper = new EntitlementHelper(
        ctx.rateLimiting.rateLimitsConfig
      );
    }
    return _entitlementHelper;
  }

  function getRateLimitChecker(): RateLimitChecker {
    if (!_rateLimitChecker) {
      _rateLimitChecker = new RateLimitChecker({
        db: db as any,
        table: rateLimitCounters as any,
      });
    }
    return _rateLimitChecker;
  }

  /**
   * Extract testMode from URL query parameter
   */
  function getTestMode(c: any): boolean {
    const url = new URL(c.req.url);
    const testMode = url.searchParams.get("testMode");
    return testMode === "true";
  }

  /**
   * Resolve whether web search runs for this call.
   *
   * The endpoint config is the gate: a caller can only ever turn search *off*,
   * never on for an endpoint that does not have it enabled.
   *
   * @param endpointDefault - The endpoint's `web_search` setting
   * @param callerPreference - The caller's preference, already extracted from the
   *   input by `extractReservedFields`; undefined when they expressed none
   */
  function resolveWebSearch(
    endpointDefault: boolean,
    callerPreference: boolean | undefined
  ): boolean {
    if (!endpointDefault) return false;
    return callerPreference ?? true;
  }

  /**
   * Check if an entity is owned by a site admin.
   * Entities owned by site admins are exempt from rate limiting.
   * This applies to both personal and organization entities.
   */
  async function isEntityOwnedBySiteAdmin(entity: EntityRow): Promise<boolean> {
    // Find the owner of the entity
    const ownerMember = await db
      .select()
      .from(entityMembers)
      .where(
        and(
          eq(entityMembers.entity_id, entity.id),
          eq(entityMembers.role, "owner"),
          eq(entityMembers.is_active, true)
        )
      )
      .limit(1);

    if (ownerMember.length === 0) {
      return false;
    }

    // Get the owner's email from the users table
    const ownerUser = await db
      .select()
      .from(users)
      .where(eq(users.firebase_uid, ownerMember[0]!.user_id))
      .limit(1);

    if (ownerUser.length === 0 || !ownerUser[0]!.email) {
      return false;
    }

    // Check if the owner's email is a site admin
    return ctx.auth.isSiteAdmin(ownerUser[0]!.email);
  }

  /**
   * Check and increment rate limits for an AI request.
   * Rate limits are per entity (personal or organizational).
   * Entities owned by site admins are exempt from rate limiting.
   * Returns null if allowed, or an error response if rate limited.
   */
  async function checkRateLimit(
    c: any,
    entity: EntityRow
  ): Promise<Response | null> {
    // Check if entity is owned by a site admin - skip rate limiting
    if (await isEntityOwnedBySiteAdmin(entity)) {
      return null;
    }

    const testMode = getTestMode(c);
    const subHelper = getSubscriptionHelper();
    if (!subHelper) {
      // RevenueCat not configured - skip rate limiting
      return null;
    }

    try {
      // Use entityId as RevenueCat subscriber ID
      // testMode is passed to filter sandbox purchases in production mode
      const subscriptionInfo = await subHelper.getSubscriptionInfo(
        entity.id,
        testMode
      );
      const limits = getEntitlementHelper().getRateLimits(
        subscriptionInfo.entitlements
      );
      const result = await getRateLimitChecker().checkAndIncrement(
        entity.id,
        limits,
        subscriptionInfo.subscriptionStartedAt
      );

      if (!result.allowed) {
        return c.json(
          errorResponse(
            `Rate limit exceeded (${result.exceededLimit ?? "unknown"} limit). ` +
              `Remaining: hourly=${result.remaining.hourly ?? "∞"}, ` +
              `daily=${result.remaining.daily ?? "∞"}, ` +
              `monthly=${result.remaining.monthly ?? "∞"}`
          ),
          429
        );
      }

      return null; // Allowed
    } catch (error) {
      // Log error but don't block request on rate limit check failure
      ctx.logger.error("Rate limit check failed:", error);
      return null;
    }
  }

  /**
   * Validate request and get all required context data.
   * This is shared between /prompt and main endpoints.
   */
  async function validateAndGetContext(c: any): Promise<ValidationResult> {
    const { organizationPath, projectName, endpointName } =
      c.req.valid("param");

    // 1. Find entity by slug (organization path is now entity slug)
    const entity = await findEntityBySlug(organizationPath);
    if (!entity) {
      return {
        success: false,
        response: c.json(errorResponse("Organization not found"), 404),
      };
    }

    // 2. Find project by name AND entity_id
    const projectRows = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.entity_id, entity.id),
          eq(projects.project_name, projectName),
          eq(projects.is_active, true)
        )
      );

    if (projectRows.length === 0) {
      return {
        success: false,
        response: c.json(errorResponse("Project not found"), 404),
      };
    }
    const project = projectRows[0]!;

    // 3. Validate API key
    const providedApiKey = extractApiKey(c);
    if (!providedApiKey) {
      return {
        success: false,
        response: c.json(
          errorResponse(
            "API key required. Provide via api_key query parameter or Authorization header"
          ),
          401
        ),
      };
    }

    if (!isValidApiKeyFormat(providedApiKey)) {
      return {
        success: false,
        response: c.json(errorResponse("Invalid API key format"), 401),
      };
    }

    // Check if project has an API key configured
    if (!project.encrypted_api_key || !project.api_key_iv) {
      return {
        success: false,
        response: c.json(errorResponse("Project API key not configured"), 500),
      };
    }

    // Validate the provided API key against stored encrypted key
    const isValidKey = validateProjectApiKey(
      providedApiKey,
      project.encrypted_api_key,
      project.api_key_iv
    );

    if (!isValidKey) {
      return {
        success: false,
        response: c.json(errorResponse("Invalid API key"), 401),
      };
    }

    // 4. Find endpoint by name within project
    const endpointRows = await db
      .select()
      .from(endpoints)
      .where(
        and(
          eq(endpoints.project_id, project.uuid),
          eq(endpoints.endpoint_name, endpointName),
          eq(endpoints.is_active, true)
        )
      );

    if (endpointRows.length === 0) {
      return {
        success: false,
        response: c.json(errorResponse("Endpoint not found"), 404),
      };
    }
    const endpoint = endpointRows[0]!;

    // 5. Validate IP allowlist (if configured on endpoint)
    const ipAllowlist = endpoint.ip_allowlist as string[] | null;
    if (ipAllowlist && ipAllowlist.length > 0) {
      const clientIp = getClientIp(c);
      if (!isIpAllowed(clientIp, ipAllowlist)) {
        return {
          success: false,
          response: c.json(
            errorResponse(
              `IP address ${clientIp ?? "unknown"} is not allowed to access this endpoint`
            ),
            403
          ),
        };
      }
    }

    // 6. Validate HTTP method matches endpoint definition
    const requestMethod = c.req.method;
    if (endpoint.http_method !== requestMethod) {
      return {
        success: false,
        response: c.json(
          errorResponse(
            `Method ${requestMethod} not allowed. Use ${endpoint.http_method}`
          ),
          405
        ),
      };
    }

    // 7. Get input data based on method
    let inputData: unknown;
    try {
      if (requestMethod === "GET") {
        // Parse query parameters
        const url = new URL(c.req.url);
        inputData = Object.fromEntries(url.searchParams);
      } else {
        // Parse JSON body
        inputData = await c.req.json();
      }
    } catch {
      return {
        success: false,
        response: c.json(errorResponse("Invalid request body"), 400),
      };
    }

    // 8. Resolve the provider credential. Where it comes from is the app's
    // business (an entity's LLM key, a site-owned provider key). Kept here,
    // before rate limiting, so a missing credential fails without consuming a
    // rate-limit count -- the order this lookup always had.
    let credential: ResolvedCredential;
    try {
      const resolved = await ctx.credentials.resolve({
        entityId: entity.id,
        endpoint,
      });
      if (!resolved.ok) {
        return {
          success: false,
          response: c.json(errorResponse(resolved.message), resolved.status),
        };
      }
      credential = resolved;
    } catch (error) {
      ctx.logger.error("Credential resolution failed:", error);
      return {
        success: false,
        response: c.json(
          errorResponse("Failed to resolve provider credential"),
          500
        ),
      };
    }

    return {
      success: true,
      entity,
      project,
      endpoint,
      credential,
      inputData,
    };
  }

  // =============================================================================
  // Prompt Endpoint Handler
  // =============================================================================

  /**
   * Handle prompt generation request - returns just the prompt without calling LLM
   */
  async function handlePromptRequest(c: any) {
    const validationResult = await validateAndGetContext(c);
    if (!validationResult.success) {
      return validationResult.response;
    }

    const { entity, endpoint, credential, inputData } = validationResult;

    // Check rate limits using entity's subscription
    const rateLimitResponse = await checkRateLimit(c, entity);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    // Strip reserved fields so the preview matches what an invocation would send
    const { context: contextOverride, cleanedInput } =
      extractReservedFields(inputData);

    // Generate the combined prompt using ApiHelper
    // Use context override if provided, otherwise use endpoint's configured context
    const prompt = ApiHelper.prompt({
      inputData: cleanedInput,
      outputSchema: endpoint.output_schema as JsonSchema | null,
      instructions: endpoint.instructions,
      context: contextOverride ?? endpoint.context,
      provider: credential.provider,
    });

    const promptResponse: AiPromptResponse = { prompt };
    return c.json(successResponse<AiPromptResponse>(promptResponse));
  }

  // =============================================================================
  // Main AI Endpoint Handler
  // =============================================================================

  /**
   * Handle AI endpoint execution - generates prompt, calls LLM, returns response
   */
  async function handleAIRequest(c: any) {
    const startTime = Date.now();

    const validationResult = await validateAndGetContext(c);
    if (!validationResult.success) {
      return validationResult.response;
    }

    const { entity, project, endpoint, credential, inputData } =
      validationResult;

    // Check rate limits using entity's subscription
    const rateLimitResponse = await checkRateLimit(c, entity);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    // App gate after rate limiting (e.g. ShapeRouter's credit balance)
    if (ctx.hooks.beforeInvoke) {
      const stop = await ctx.hooks.beforeInvoke({
        c,
        entity,
        project,
        endpoint,
        provider: credential.provider,
      });
      if (stop) return stop;
    }

    // Pull out every reserved field in one pass, before anything builds a prompt
    const {
      context: contextOverride,
      webSearch: webSearchPreference,
      maxOutputTokens: requestedMaxOutputTokens,
      cleanedInput: inputWithoutReserved,
    } = extractReservedFields(inputData);

    // Resolve the output ceiling: the caller may lower the endpoint's limit but
    // never raise it. A malformed value fails the request rather than silently
    // leaving the caller unprotected.
    const ceiling = resolveMaxOutputTokens(
      endpoint.max_output_tokens,
      requestedMaxOutputTokens
    );
    if (!ceiling.ok) {
      return c.json(errorResponse(ceiling.error), 400);
    }

    // Extract media from input data (after removing reserved fields)
    const extractionResult = extractMediaFromInput(
      inputWithoutReserved as Record<string, unknown>
    );
    if (extractionResult.error) {
      return c.json(errorResponse(extractionResult.error), 400);
    }
    const { cleanedInput, media: extractedMedia } = extractionResult.result!;

    // Convert unsupported image formats (SVG, TIFF, etc.) to PNG
    let media = extractedMedia;
    if (extractedMedia.length > 0) {
      try {
        media = await convertAllMediaIfNeeded(extractedMedia);
      } catch (conversionError) {
        const errorMessage =
          conversionError instanceof Error
            ? conversionError.message
            : "Failed to convert image format";
        return c.json(errorResponse(errorMessage), 400);
      }
    }

    // Determine model (from endpoint config)
    const model = endpoint.model ?? undefined;

    // Validate media capabilities if media was extracted
    if (media.length > 0 && model) {
      const validation = validateMediaCapabilities({
        model,
        provider: credential.provider,
        inputMedia: media,
        expectsOutput: {
          // For now, we don't have explicit output config in endpoints
          // This can be extended when we add output media support
        },
      });

      if (!validation.valid) {
        return c.json(errorResponse(validation.errors.join("; ")), 400);
      }

      // Additional Whisper validation
      if (isTranscriptionModel(model)) {
        const whisperValidation = validateWhisperRequest(model, media);
        if (!whisperValidation.valid) {
          return c.json(
            errorResponse(whisperValidation.errors.join("; ")),
            400
          );
        }
      }
    }

    // Build the prompts for LLM call (providers expect system/user format)
    // Use cleaned input (media replaced with placeholders)
    // Use context override if provided, otherwise use endpoint's configured context
    const prompts = ApiHelper.buildLegacyPrompts({
      inputData: cleanedInput,
      outputSchema: endpoint.output_schema as JsonSchema | null,
      instructions: endpoint.instructions,
      context: contextOverride ?? endpoint.context,
      provider: credential.provider,
    });

    // Parse media output configuration from endpoint
    const expectsMediaOutput = endpoint.expects_media_output as {
      audio?: boolean;
      image?: boolean;
      video?: boolean;
    } | null;

    // Create LLM request with media
    // Use proper discriminated union based on output format
    const baseRequest = {
      prompt: prompts.user,
      systemPrompt: prompts.system,
      outputSchema: (endpoint.output_schema as JsonSchema) ?? {
        type: "object",
      },
      model,
      media: media.length > 0 ? media : undefined,
      expectsMediaOutput: expectsMediaOutput ?? undefined,
      webSearch: resolveWebSearch(
        endpoint.web_search ?? false,
        webSearchPreference
      ),
      // null means the endpoint opted out of runaway protection; the providers
      // treat undefined as "no limit".
      maxTokens: ceiling.value ?? undefined,
      /*
        NULL becomes undefined rather than 0, and the two are different answers.

        Undefined leaves every adapter exactly as it was: OpenAI, Gemini, Groq
        and the custom provider apply their own `?? 0`, while Anthropic omits the
        field entirely because Opus 4.7+ and Sonnet 5 reject it with a 400.
        Passing 0 here would send a value to the models that refuse one, and
        would do it to every endpoint that predates this column.
      */
      temperature: endpoint.temperature ?? undefined,
    };

    const llmRequest: LLMRequest =
      endpoint.output_media_format === "url"
        ? {
            ...baseRequest,
            outputMediaFormat: "url" as const,
            entityId: endpoint.uuid,
          }
        : { ...baseRequest, outputMediaFormat: "base64" as const };

    // 4. Call LLM and return response
    const provider = ctx.createProvider(credential.provider, {
      apiKey: credential.apiKey,
      endpointUrl: credential.endpointUrl,
      timeoutMs: credential.timeoutMs,
    });

    // Debug info for troubleshooting (get actual URL from provider if available)
    const actualEndpointUrl =
      "getEndpointUrl" in provider
        ? (provider as { getEndpointUrl: () => string }).getEndpointUrl()
        : credential.endpointUrl;
    const debugInfo = {
      provider: credential.provider,
      endpointUrl: actualEndpointUrl,
      request: llmRequest,
    };

    ctx.logger.log("[AI] Prompt sent to LLM:", {
      provider: credential.provider,
      model,
      instructions: endpoint.instructions,
      systemPrompt: prompts.system,
      userPrompt: prompts.user,
    });

    try {
      const llmResponse = await provider.generate(llmRequest);

      ctx.logger.log("[AI] LLM response:", {
        provider: llmResponse.provider,
        model: llmResponse.model,
        content: llmResponse.content,
        usage: llmResponse.usage,
        latencyMs: llmResponse.latencyMs,
      });

      // 5. Calculate cost
      const pricing = getModelPricing(llmResponse.model);
      const costCents = estimateCost(
        pricing,
        llmResponse.usage.promptTokens,
        llmResponse.usage.completionTokens
      );

      // 6. Log analytics and count the call
      await incrementCallCount(endpoint.uuid);
      const analyticsValues = {
        endpoint_id: endpoint.uuid,
        success: true,
        tokens_input: llmResponse.usage.promptTokens,
        tokens_output: llmResponse.usage.completionTokens,
        latency_ms: llmResponse.latencyMs,
        estimated_cost_cents: Math.round(costCents),
        request_metadata: {
          model: llmResponse.model,
          provider: llmResponse.provider,
          ...(llmResponse.finishReason
            ? { finish_reason: llmResponse.finishReason }
            : {}),
          ...(ceiling.value !== null
            ? { max_output_tokens: ceiling.value }
            : {}),
        },
      };

      const afterInvoke = ctx.hooks.afterInvoke;
      if (afterInvoke) {
        // Settlement and the analytics row commit together or not at all. A
        // failure here fails the request even though the provider answered:
        // an unrecorded charge is worse than a retry.
        try {
          await db.transaction(async tx => {
            const [row] = await tx
              .insert(usageAnalytics)
              .values(analyticsValues)
              .returning({ uuid: usageAnalytics.uuid });
            await afterInvoke({
              tx,
              entity,
              endpoint,
              usageAnalyticsId: row!.uuid,
              provider: credential.provider,
              model: llmResponse.model,
              usage: {
                promptTokens: llmResponse.usage.promptTokens,
                completionTokens: llmResponse.usage.completionTokens,
              },
              providerCostMicroCents: toMicroCents(costCents),
            });
          });
        } catch (settleError) {
          ctx.logger.error("Usage settlement failed:", settleError);
          return c.json(
            errorResponse("Failed to record usage for this call"),
            500
          );
        }
      } else {
        await db.insert(usageAnalytics).values(analyticsValues);
      }

      // 7. Return response with generated media if present
      const response: AiExecutionResponse = {
        output: llmResponse.content,
        usage: {
          tokens_input: llmResponse.usage.promptTokens,
          tokens_output: llmResponse.usage.completionTokens,
          latency_ms: llmResponse.latencyMs,
          estimated_cost_cents: costCents,
          ...(llmResponse.finishReason
            ? { finish_reason: llmResponse.finishReason }
            : {}),
        },
      };

      // Hitting the ceiling means `output` is a truncated answer that will
      // usually fail the caller's schema validation. Saying so explicitly is what
      // lets a caller tell "the model ran away" from "the model returned
      // something unparseable" -- different faults, different correct responses.
      if (llmResponse.finishReason === "length") {
        response.truncated = true;
        ctx.logger.warn("[AI] Output truncated at token ceiling:", {
          endpoint: endpoint.endpoint_name,
          maxOutputTokens: ceiling.value,
          tokensOutput: llmResponse.usage.completionTokens,
        });
      }

      // Include generated media if present
      if (llmResponse.generatedMedia && llmResponse.generatedMedia.length > 0) {
        response.generated_media = llmResponse.generatedMedia;
      }

      return c.json(successResponse<AiExecutionResponse>(response));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const latencyMs = Date.now() - startTime;
      const errorDetails =
        error instanceof Error &&
        "details" in error &&
        error.details &&
        typeof error.details === "object"
          ? (error.details as Record<string, unknown>)
          : undefined;

      // Log failed analytics and count the call: the endpoint was invoked, so it
      // counts whether or not the provider answered.
      await incrementCallCount(endpoint.uuid);
      await db.insert(usageAnalytics).values({
        endpoint_id: endpoint.uuid,
        success: false,
        error_message: errorMessage,
        latency_ms: latencyMs,
        request_metadata: errorDetails
          ? {
              model: debugInfo.request.model,
              provider: debugInfo.provider,
              error_details: errorDetails,
            }
          : undefined,
      });

      ctx.logger.error("LLM processing failed:", errorMessage, {
        ...debugInfo,
        errorDetails,
      });

      return c.json(
        {
          ...errorResponse(`LLM processing failed: ${errorMessage}`),
          details: errorDetails,
        },
        500
      );
    }
  }

  // =============================================================================
  // Route Registration
  // =============================================================================

  // IMPORTANT: Register /prompt routes BEFORE the main routes
  // Otherwise ":endpointName" will match "prompt" as the endpoint name

  // Prompt-only endpoints (new)
  aiRouter.get(
    "/:organizationPath/:projectName/:endpointName/prompt",
    zValidator("param", aiParamSchema),
    handlePromptRequest
  );

  aiRouter.post(
    "/:organizationPath/:projectName/:endpointName/prompt",
    zValidator("param", aiParamSchema),
    handlePromptRequest
  );

  // Main AI execution endpoints
  aiRouter.get(
    "/:organizationPath/:projectName/:endpointName",
    zValidator("param", aiParamSchema),
    handleAIRequest
  );

  aiRouter.post(
    "/:organizationPath/:projectName/:endpointName",
    zValidator("param", aiParamSchema),
    handleAIRequest
  );

  return aiRouter;
}
