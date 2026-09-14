/**
 * @fileoverview Analytics routes
 * @description Provides aggregated usage analytics per entity with
 * optional date, project, and endpoint filters.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { analyticsQuerySchema } from "../schemas/index.js";
import {
  successResponse,
  errorResponse,
  type UsageAggregate,
  type UsageByEndpoint,
  type AnalyticsResponse,
} from "@sudobility/shapeshyft_engine/types";
import type { ServiceContext } from "../context.js";

export function createAnalyticsRouter(ctx: ServiceContext) {
  const { db } = ctx;
  const { projects, endpoints, usageAnalytics, entities, entityMembers } =
    ctx.tables;

  const analyticsRouter = new Hono();

  /**
   * Verify user has access to entity and return its ID.
   */
  async function getEntityIdForAnalytics(
    c: any,
    firebaseUid: string
  ): Promise<{ entityId: string | null; error: string | null }> {
    const entitySlug = c.req.param("entitySlug");

    if (!entitySlug) {
      return { entityId: null, error: "entitySlug is required" };
    }

    // Look up entity by slug
    const entityRows = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_slug, entitySlug));

    if (entityRows.length === 0) {
      return { entityId: null, error: "Entity not found" };
    }

    const entity = entityRows[0]!;

    // Verify user has access to this entity
    const memberRows = await db
      .select()
      .from(entityMembers)
      .where(eq(entityMembers.entity_id, entity.id));

    const isMember = memberRows.some(
      m => m.user_id === firebaseUid && m.is_active
    );
    if (!isMember) {
      return { entityId: null, error: "Access denied to entity" };
    }

    return { entityId: entity.id, error: null };
  }

  /**
   * GET /entities/:entitySlug/analytics
   * Returns analytics for a specific entity
   */
  analyticsRouter.get(
    "/",
    zValidator("query", analyticsQuerySchema),
    async c => {
      const userId = c.get("userId");

      // Get entity ID from path parameter
      const { entityId, error: entityError } = await getEntityIdForAnalytics(
        c,
        userId
      );

      if (entityError || !entityId) {
        const status =
          entityError === "entitySlug is required"
            ? 400
            : entityError === "Access denied to entity"
              ? 403
              : 404;
        return c.json(errorResponse(entityError || "Entity not found"), status);
      }

      const query = c.req.valid("query");

      // Get all projects for this entity
      const entityProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.entity_id, entityId));

      if (entityProjects.length === 0) {
        const emptyResponse: AnalyticsResponse = {
          aggregate: {
            total_requests: 0,
            successful_requests: 0,
            failed_requests: 0,
            total_tokens_input: 0,
            total_tokens_output: 0,
            total_estimated_cost_cents: 0,
            average_latency_ms: 0,
          },
          by_endpoint: [],
        };
        return c.json(successResponse<AnalyticsResponse>(emptyResponse));
      }

      const projectIds = entityProjects.map(p => p.uuid);

      // Get all endpoints for entity's projects
      const entityEndpoints = await db
        .select()
        .from(endpoints)
        .where(sql`${endpoints.project_id} IN ${projectIds}`);

      if (entityEndpoints.length === 0) {
        const emptyResponse: AnalyticsResponse = {
          aggregate: {
            total_requests: 0,
            successful_requests: 0,
            failed_requests: 0,
            total_tokens_input: 0,
            total_tokens_output: 0,
            total_estimated_cost_cents: 0,
            average_latency_ms: 0,
          },
          by_endpoint: [],
        };
        return c.json(successResponse<AnalyticsResponse>(emptyResponse));
      }

      const endpointIds = entityEndpoints.map(e => e.uuid);
      const endpointNameMap = new Map(
        entityEndpoints.map(e => [e.uuid, e.endpoint_name])
      );

      // Build conditions for analytics query
      const conditions = [sql`${usageAnalytics.endpoint_id} IN ${endpointIds}`];

      if (query.start_date) {
        conditions.push(
          gte(
            usageAnalytics.timestamp,
            new Date(query.start_date + "T00:00:00Z")
          )
        );
      }
      if (query.end_date) {
        conditions.push(
          lte(usageAnalytics.timestamp, new Date(query.end_date + "T23:59:59Z"))
        );
      }
      if (query.endpoint_id) {
        conditions.push(eq(usageAnalytics.endpoint_id, query.endpoint_id));
      }
      if (query.project_id) {
        // Filter endpoints by project
        const projectEndpoints = entityEndpoints
          .filter(e => e.project_id === query.project_id)
          .map(e => e.uuid);
        if (projectEndpoints.length === 0) {
          const emptyResponse: AnalyticsResponse = {
            aggregate: {
              total_requests: 0,
              successful_requests: 0,
              failed_requests: 0,
              total_tokens_input: 0,
              total_tokens_output: 0,
              total_estimated_cost_cents: 0,
              average_latency_ms: 0,
            },
            by_endpoint: [],
          };
          return c.json(successResponse<AnalyticsResponse>(emptyResponse));
        }
        conditions.push(
          sql`${usageAnalytics.endpoint_id} IN ${projectEndpoints}`
        );
      }

      // Get aggregated stats
      const aggregateResult = await db
        .select({
          total_requests: sql<number>`COUNT(*)`,
          successful_requests: sql<number>`SUM(CASE WHEN ${usageAnalytics.success} THEN 1 ELSE 0 END)`,
          failed_requests: sql<number>`SUM(CASE WHEN NOT ${usageAnalytics.success} THEN 1 ELSE 0 END)`,
          total_tokens_input: sql<number>`COALESCE(SUM(${usageAnalytics.tokens_input}), 0)`,
          total_tokens_output: sql<number>`COALESCE(SUM(${usageAnalytics.tokens_output}), 0)`,
          total_estimated_cost_cents: sql<number>`COALESCE(SUM(COALESCE(${usageAnalytics.estimated_cost_micro_cents}, ${usageAnalytics.estimated_cost_cents}::bigint * 1000000)), 0) / 1000000.0`,
          average_latency_ms: sql<number>`COALESCE(AVG(${usageAnalytics.latency_ms}), 0)`,
        })
        .from(usageAnalytics)
        .where(and(...conditions));

      const aggregate: UsageAggregate = {
        total_requests: Number(aggregateResult[0]?.total_requests ?? 0),
        successful_requests: Number(
          aggregateResult[0]?.successful_requests ?? 0
        ),
        failed_requests: Number(aggregateResult[0]?.failed_requests ?? 0),
        total_tokens_input: Number(aggregateResult[0]?.total_tokens_input ?? 0),
        total_tokens_output: Number(
          aggregateResult[0]?.total_tokens_output ?? 0
        ),
        total_estimated_cost_cents: Number(
          aggregateResult[0]?.total_estimated_cost_cents ?? 0
        ),
        average_latency_ms: Math.round(
          Number(aggregateResult[0]?.average_latency_ms ?? 0)
        ),
      };

      // Get stats by endpoint
      const byEndpointResult = await db
        .select({
          endpoint_id: usageAnalytics.endpoint_id,
          total_requests: sql<number>`COUNT(*)`,
          successful_requests: sql<number>`SUM(CASE WHEN ${usageAnalytics.success} THEN 1 ELSE 0 END)`,
          failed_requests: sql<number>`SUM(CASE WHEN NOT ${usageAnalytics.success} THEN 1 ELSE 0 END)`,
          total_tokens_input: sql<number>`COALESCE(SUM(${usageAnalytics.tokens_input}), 0)`,
          total_tokens_output: sql<number>`COALESCE(SUM(${usageAnalytics.tokens_output}), 0)`,
          total_estimated_cost_cents: sql<number>`COALESCE(SUM(COALESCE(${usageAnalytics.estimated_cost_micro_cents}, ${usageAnalytics.estimated_cost_cents}::bigint * 1000000)), 0) / 1000000.0`,
          average_latency_ms: sql<number>`COALESCE(AVG(${usageAnalytics.latency_ms}), 0)`,
        })
        .from(usageAnalytics)
        .where(and(...conditions))
        .groupBy(usageAnalytics.endpoint_id);

      const byEndpoint: UsageByEndpoint[] = byEndpointResult.map(row => ({
        endpoint_id: row.endpoint_id,
        endpoint_name: endpointNameMap.get(row.endpoint_id) ?? "unknown",
        total_requests: Number(row.total_requests),
        successful_requests: Number(row.successful_requests),
        failed_requests: Number(row.failed_requests),
        total_tokens_input: Number(row.total_tokens_input),
        total_tokens_output: Number(row.total_tokens_output),
        total_estimated_cost_cents: Number(row.total_estimated_cost_cents),
        average_latency_ms: Math.round(Number(row.average_latency_ms)),
      }));

      const response: AnalyticsResponse = {
        aggregate,
        by_endpoint: byEndpoint,
      };

      return c.json(successResponse<AnalyticsResponse>(response));
    }
  );

  return analyticsRouter;
}
