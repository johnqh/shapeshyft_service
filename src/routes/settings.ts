/**
 * @fileoverview User settings routes
 * @description Manages per-user settings including organization name and path.
 * Uses upsert pattern -- settings are created on first PUT if they don't exist.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { settingsUpdateSchema } from "../schemas/index.js";
import {
  successResponse,
  errorResponse,
  type UserSettings,
} from "@sudobility/shapeshyft_engine/types";
import type { ServiceContext } from "../context.js";

export function createSettingsRouter(ctx: ServiceContext) {
  const { db } = ctx;
  const { users, userSettings } = ctx.tables;

  const settingsRouter = new Hono();

  /**
   * Helper to get or create user by Firebase UID
   */
  async function getOrCreateUser(firebaseUid: string, email?: string) {
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.firebase_uid, firebaseUid));

    if (existing.length > 0) {
      return existing[0]!;
    }

    const created = await db
      .insert(users)
      .values({
        firebase_uid: firebaseUid,
        email: email ?? null,
      })
      .returning();

    return created[0]!;
  }

  /**
   * Generate default organization path from firebase UID
   * Uses first 8 characters of the UID (without special characters)
   */
  function generateDefaultOrgPath(firebaseUid: string): string {
    return firebaseUid.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  }

  // GET user settings
  settingsRouter.get("/", async c => {
    const authUserId = c.get("userId");
    const authUserEmail = c.get("userEmail");
    const userId = c.req.param("userId");

    if (authUserId !== userId) {
      return c.json(
        errorResponse("You can only access your own settings"),
        403
      );
    }

    const user = await getOrCreateUser(authUserId, authUserEmail ?? undefined);

    const rows = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.firebase_uid, user.firebase_uid));

    if (rows.length === 0) {
      // Return default settings with auto-generated org path
      const defaultSettings: UserSettings = {
        id: null,
        firebase_uid: user.firebase_uid,
        organization_name: null,
        organization_path: generateDefaultOrgPath(user.firebase_uid),
        is_default: true,
        created_at: null,
        updated_at: null,
      };
      return c.json(successResponse<UserSettings>(defaultSettings));
    }

    const settings: UserSettings = { ...rows[0], is_default: false };
    return c.json(successResponse<UserSettings>(settings));
  });

  // PUT create/update settings (upsert)
  settingsRouter.put("/", zValidator("json", settingsUpdateSchema), async c => {
    const authUserId = c.get("userId");
    const authUserEmail = c.get("userEmail");
    const userId = c.req.param("userId");
    const body = c.req.valid("json");

    if (authUserId !== userId) {
      return c.json(
        errorResponse("You can only update your own settings"),
        403
      );
    }

    const user = await getOrCreateUser(authUserId, authUserEmail ?? undefined);

    // Check if settings exist
    const existing = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.firebase_uid, user.firebase_uid));

    // If changing organization_path, check for duplicates
    if (body.organization_path) {
      const duplicate = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.organization_path, body.organization_path));

      if (
        duplicate.length > 0 &&
        (existing.length === 0 ||
          duplicate[0]!.firebase_uid !== user.firebase_uid)
      ) {
        return c.json(errorResponse("Organization path already taken"), 409);
      }
    }

    if (existing.length === 0) {
      // Create new settings
      const orgPath =
        body.organization_path || generateDefaultOrgPath(user.firebase_uid);

      // Double-check the auto-generated path isn't taken
      if (!body.organization_path) {
        const autoPathCheck = await db
          .select()
          .from(userSettings)
          .where(eq(userSettings.organization_path, orgPath));

        if (autoPathCheck.length > 0) {
          return c.json(
            errorResponse(
              "Auto-generated organization path is taken. Please provide a custom organization_path."
            ),
            409
          );
        }
      }

      const rows = await db
        .insert(userSettings)
        .values({
          firebase_uid: user.firebase_uid,
          organization_name: body.organization_name ?? null,
          organization_path: orgPath,
        })
        .returning();

      const created: UserSettings = { ...rows[0]!, is_default: false };
      return c.json(successResponse<UserSettings>(created), 201);
    }

    // Update existing settings
    const current = existing[0]!;
    const rows = await db
      .update(userSettings)
      .set({
        organization_name: body.organization_name ?? current.organization_name,
        organization_path: body.organization_path ?? current.organization_path,
        updated_at: new Date(),
      })
      .where(eq(userSettings.firebase_uid, user.firebase_uid))
      .returning();

    const updated: UserSettings = { ...rows[0]!, is_default: false };
    return c.json(successResponse<UserSettings>(updated));
  });

  return settingsRouter;
}
