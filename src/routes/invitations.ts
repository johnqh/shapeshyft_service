/**
 * @fileoverview User Invitation Routes
 * @description API routes for managing user's pending invitations
 */

import { Hono } from "hono";
import {
  successResponse,
  errorResponse,
} from "@sudobility/shapeshyft_engine/types";
import type { EntityInvitation } from "@sudobility/types";
import type { ServiceContext } from "../context.js";

type Variables = {
  userId: string;
  userEmail: string | null;
};

export function createInvitationsRouter(ctx: ServiceContext) {
  const helpers = ctx.entityAccess.entityHelpers;

  const invitationsRouter = new Hono<{ Variables: Variables }>();

  /**
   * GET /invitations - List pending invitations for the current user
   */
  invitationsRouter.get("/", async c => {
    const userEmail = c.get("userEmail");

    if (!userEmail) {
      return c.json(successResponse<EntityInvitation[]>([]));
    }

    try {
      const invitations =
        await helpers.invitations.getUserPendingInvitations(userEmail);
      return c.json(successResponse<EntityInvitation[]>(invitations));
    } catch (error: any) {
      console.error("Error listing user invitations:", error);
      return c.json(
        errorResponse(error.message || "Internal server error"),
        500
      );
    }
  });

  /**
   * POST /invitations/:token/accept - Accept an invitation
   */
  invitationsRouter.post("/:token/accept", async c => {
    const userId = c.get("userId");
    const token = c.req.param("token");

    try {
      await helpers.invitations.acceptInvitation(token, userId);
      return c.json(successResponse<null>(null));
    } catch (error: any) {
      console.error("Error accepting invitation:", error);
      return c.json(errorResponse(error.message || "Bad request"), 400);
    }
  });

  /**
   * POST /invitations/:token/decline - Decline an invitation
   */
  invitationsRouter.post("/:token/decline", async c => {
    const token = c.req.param("token");

    try {
      await helpers.invitations.declineInvitation(token);
      return c.json(successResponse<null>(null));
    } catch (error: any) {
      console.error("Error declining invitation:", error);
      return c.json(errorResponse(error.message || "Bad request"), 400);
    }
  });

  return invitationsRouter;
}
