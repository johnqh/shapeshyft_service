/**
 * @fileoverview Project management routes
 * @description CRUD operations for projects. Each project gets an auto-generated
 * API key on creation. Includes API key retrieval and refresh endpoints.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import {
  projectCreateSchema,
  projectUpdateSchema,
  projectIdParamSchema,
  entitySlugParamSchema,
} from "../schemas/index.js";
import {
  successResponse,
  errorResponse,
  type Project,
  type GetApiKeyResponse,
  type RefreshApiKeyResponse,
} from "@sudobility/shapeshyft_engine/types";
import { publicProject } from "../lib/public-project.js";
import type { ServiceContext } from "../context.js";

export function createProjectsRouter(ctx: ServiceContext) {
  const { db } = ctx;
  const { projects } = ctx.tables;
  const { generateProjectApiKey, encryptProjectApiKey, decryptProjectApiKey } =
    ctx.projectApiKeys;
  const { getActor, getEntityWithPermission, getPermissionErrorStatus } =
    ctx.entityAccess;

  const projectsRouter = new Hono();

  // GET all projects for entity
  projectsRouter.get(
    "/",
    zValidator("param", entitySlugParamSchema),
    async c => {
      try {
        const { entitySlug } = c.req.valid("param");

        const result = await getEntityWithPermission(entitySlug, getActor(c));
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        const rows = await db
          .select()
          .from(projects)
          .where(eq(projects.entity_id, result.entity.id));

        return c.json(
          successResponse<Project[]>(rows.map(publicProject) as Project[])
        );
      } catch (error: any) {
        console.error("Error getting projects:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // GET single project
  projectsRouter.get(
    "/:projectId",
    zValidator("param", projectIdParamSchema),
    async c => {
      try {
        const { entitySlug, projectId } = c.req.valid("param");

        const result = await getEntityWithPermission(entitySlug, getActor(c));
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        const rows = await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.entity_id, result.entity.id),
              eq(projects.uuid, projectId)
            )
          );

        if (rows.length === 0) {
          return c.json(errorResponse("Project not found"), 404);
        }

        return c.json(
          successResponse<Project>(publicProject(rows[0]) as Project)
        );
      } catch (error: any) {
        console.error("Error getting project:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // POST create project
  projectsRouter.post(
    "/",
    zValidator("param", entitySlugParamSchema),
    zValidator("json", projectCreateSchema),
    async c => {
      try {
        const { entitySlug } = c.req.valid("param");
        const body = c.req.valid("json");

        const result = await getEntityWithPermission(
          entitySlug,
          getActor(c),
          true
        );
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        // Check for duplicate project name
        const existing = await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.entity_id, result.entity.id),
              eq(projects.project_name, body.project_name)
            )
          );

        if (existing.length > 0) {
          return c.json(errorResponse("Project name already exists"), 409);
        }

        // Generate API key for the project
        const { key, prefix } = generateProjectApiKey();
        const { encrypted, iv } = encryptProjectApiKey(key);

        const rows = await db
          .insert(projects)
          .values({
            entity_id: result.entity.id,
            project_name: body.project_name,
            display_name: body.display_name,
            description: body.description ?? null,
            encrypted_api_key: encrypted,
            api_key_iv: iv,
            api_key_prefix: prefix,
            api_key_created_at: new Date(),
          })
          .returning();

        return c.json(successResponse<Project>(rows[0] as Project), 201);
      } catch (error: any) {
        console.error("Error creating project:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // PUT update project
  projectsRouter.put(
    "/:projectId",
    zValidator("param", projectIdParamSchema),
    zValidator("json", projectUpdateSchema),
    async c => {
      try {
        const { entitySlug, projectId } = c.req.valid("param");
        const body = c.req.valid("json");

        const result = await getEntityWithPermission(
          entitySlug,
          getActor(c),
          true
        );
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        // Check if project exists
        const existing = await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.entity_id, result.entity.id),
              eq(projects.uuid, projectId)
            )
          );

        if (existing.length === 0) {
          return c.json(errorResponse("Project not found"), 404);
        }

        const current = existing[0]!;

        // Check for duplicate project name if changing
        if (body.project_name && body.project_name !== current.project_name) {
          const duplicate = await db
            .select()
            .from(projects)
            .where(
              and(
                eq(projects.entity_id, result.entity.id),
                eq(projects.project_name, body.project_name)
              )
            );

          if (duplicate.length > 0) {
            return c.json(errorResponse("Project name already exists"), 409);
          }
        }

        const rows = await db
          .update(projects)
          .set({
            project_name: body.project_name ?? current.project_name,
            display_name: body.display_name ?? current.display_name,
            description: body.description ?? current.description,
            is_active: body.is_active ?? current.is_active,
            updated_at: new Date(),
          })
          .where(eq(projects.uuid, projectId))
          .returning();

        return c.json(successResponse<Project>(rows[0] as Project));
      } catch (error: any) {
        console.error("Error updating project:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // DELETE project
  projectsRouter.delete(
    "/:projectId",
    zValidator("param", projectIdParamSchema),
    async c => {
      try {
        const { entitySlug, projectId } = c.req.valid("param");

        const result = await getEntityWithPermission(
          entitySlug,
          getActor(c),
          true
        );
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        const rows = await db
          .delete(projects)
          .where(
            and(
              eq(projects.entity_id, result.entity.id),
              eq(projects.uuid, projectId)
            )
          )
          .returning();

        if (rows.length === 0) {
          return c.json(errorResponse("Project not found"), 404);
        }

        return c.json(successResponse<Project>(rows[0] as Project));
      } catch (error: any) {
        console.error("Error deleting project:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // GET project API key (full key - authenticated)
  projectsRouter.get(
    "/:projectId/api-key",
    zValidator("param", projectIdParamSchema),
    async c => {
      try {
        const { entitySlug, projectId } = c.req.valid("param");

        const result = await getEntityWithPermission(entitySlug, getActor(c));
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        const rows = await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.entity_id, result.entity.id),
              eq(projects.uuid, projectId)
            )
          );

        if (rows.length === 0) {
          return c.json(errorResponse("Project not found"), 404);
        }

        const project = rows[0]!;

        if (!project.encrypted_api_key || !project.api_key_iv) {
          return c.json(
            errorResponse("API key not found for this project"),
            404
          );
        }

        const apiKey = decryptProjectApiKey(
          project.encrypted_api_key,
          project.api_key_iv
        );

        const response: GetApiKeyResponse = {
          api_key: apiKey,
        };
        return c.json(successResponse<GetApiKeyResponse>(response));
      } catch (error: any) {
        console.error("Error getting project API key:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // POST refresh project API key
  projectsRouter.post(
    "/:projectId/api-key/refresh",
    zValidator("param", projectIdParamSchema),
    async c => {
      try {
        const { entitySlug, projectId } = c.req.valid("param");

        const result = await getEntityWithPermission(
          entitySlug,
          getActor(c),
          true
        );
        if (result.error !== undefined) {
          return c.json(
            errorResponse(result.error),
            getPermissionErrorStatus(result.errorCode)
          );
        }

        // Check if project exists
        const existing = await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.entity_id, result.entity.id),
              eq(projects.uuid, projectId)
            )
          );

        if (existing.length === 0) {
          return c.json(errorResponse("Project not found"), 404);
        }

        // Generate new API key
        const { key, prefix } = generateProjectApiKey();
        const { encrypted, iv } = encryptProjectApiKey(key);
        const createdAt = new Date();

        await db
          .update(projects)
          .set({
            encrypted_api_key: encrypted,
            api_key_iv: iv,
            api_key_prefix: prefix,
            api_key_created_at: createdAt,
            updated_at: createdAt,
          })
          .where(eq(projects.uuid, projectId));

        const response: RefreshApiKeyResponse = {
          api_key: key,
          api_key_prefix: prefix,
          api_key_created_at: createdAt.toISOString(),
        };
        return c.json(successResponse<RefreshApiKeyResponse>(response));
      } catch (error: any) {
        console.error("Error refreshing project API key:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  return projectsRouter;
}
