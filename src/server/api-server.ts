/**
 * @fileoverview The API process: Hono app, health checks, and Bun server options
 * @description What every shell's `index.ts` used to build by hand: logging,
 * CORS, a body limit sized for base64 media, liveness and readiness routes,
 * the `/api/v1` mount, database initialization on boot, and a Bun `fetch`
 * that lets a long provider call outlive the server's idle timer.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as requestLogger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { sql } from "drizzle-orm";
import {
  errorResponse,
  successResponse,
} from "@sudobility/shapeshyft_engine/types";
import type { Logger } from "../contracts.js";

/** 50 MB: base64-encoded media inflates payloads by a third. */
export const DEFAULT_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

export interface ApiServerConfig {
  /** Shown by `GET /` and in the startup log, e.g. "ShapeShyft API". */
  name: string;
  version?: string;
  /** Everything served under `/api/v1`. */
  routes: Hono;
  /** Used by `/health/ready`; anything with drizzle's `execute`. */
  db: { execute(query: ReturnType<typeof sql>): Promise<ArrayLike<unknown>> };
  /** Creates and migrates the schema. Run on `start()`; a failure exits. */
  initDatabase(): Promise<void>;
  port: number;
  bodyLimitBytes?: number;
  logger?: Logger;
}

export interface ApiServer {
  app: Hono;
  /** Initialize the database, logging, and exit the process on failure. */
  start(): Promise<void>;
  /** Pass as the module's default export for `bun run`. */
  bunServer: {
    port: number;
    idleTimeout: number;
    fetch(
      request: Request,
      server: { timeout: (req: Request, seconds: number) => void }
    ): Response | Promise<Response>;
  };
}

export function createApiServer(config: ApiServerConfig): ApiServer {
  const log = config.logger ?? console;
  const maxSize = config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const app = new Hono();

  app.use("*", requestLogger());
  app.use("*", cors());
  app.use(
    "*",
    bodyLimit({
      maxSize,
      onError: c =>
        c.json(
          errorResponse(
            `Request body too large. Maximum size is ${Math.round(maxSize / (1024 * 1024))}MB.`
          ),
          413
        ),
    })
  );

  app.get("/", c =>
    c.json(
      successResponse({
        name: config.name,
        version: config.version ?? "1.0.0",
        status: "healthy",
      })
    )
  );

  // Liveness: the process answers. Public, no database.
  app.get("/health", c => c.json(successResponse({ status: "healthy" })));

  // Readiness: the database answers. Public; 503 until it does.
  app.get("/health/ready", async c => {
    try {
      const result = await config.db.execute(sql`SELECT 1 as ok`);
      if (result.length > 0) {
        return c.json(
          successResponse({ status: "ready", database: "connected" })
        );
      }
      return c.json(errorResponse("Database check returned no rows"), 503);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log.error("Health check failed:", message);
      return c.json(errorResponse(`Database not ready: ${message}`), 503);
    }
  });

  app.route("/api/v1", config.routes);

  return {
    app,
    async start() {
      try {
        await config.initDatabase();
        log.log(`${config.name} running on http://localhost:${config.port}`);
      } catch (error) {
        log.error("Failed to initialize database:", error);
        process.exit(1);
      }
    },
    bunServer: {
      port: config.port,
      /*
        Long provider calls must not be cut off by the server's idle timer.

        Bun closes a connection after `idleTimeout` seconds of silence and caps
        that value at 255 -- and a request here is silent for its whole life,
        because the provider is generating and nothing is written back until it
        finishes. A local model answering with a dense score takes longer than
        that: measured against LM Studio, ordinary parts returned in 86-175s
        while a drum kit, which writes three times the notes per bar, ran past
        four minutes and the socket died under it.

        `server.timeout(req, 0)` lifts the limit for the request in hand rather
        than for the process, so an ordinary request keeps the protection.
      */
      idleTimeout: 255,
      fetch(request, server) {
        server.timeout(request, 0);
        return app.fetch(request, server);
      },
    },
  };
}
