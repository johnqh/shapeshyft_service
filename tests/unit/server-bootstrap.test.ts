import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { createEnvReader, parseEnvFile } from "../../src/server/env.js";
import { createApiServer } from "../../src/server/api-server.js";
import { createLazyDatabase } from "../../src/server/database.js";
import { createFirebaseAuth } from "../../src/server/firebase-auth.js";
import {
  createInvitationEmailSender,
  renderInvitationEmail,
} from "../../src/server/invitation-email.js";

const silent = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("createEnvReader", () => {
  const envFile = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), "env-reader-"));
    const path = join(dir, ".env.local");
    writeFileSync(path, content);
    return path;
  };

  it("prefers .env.local, then the environment, then the default", () => {
    const env = createEnvReader({
      envFile: envFile('A="from file"\n# comment\nB=\n'),
      processEnv: { A: "from env", B: "from env", C: "from env" },
    });
    expect(env.get("A")).toBe("from file");
    expect(env.get("B")).toBe("from env"); // an empty file value does not count
    expect(env.get("C")).toBe("from env");
    expect(env.get("D", "fallback")).toBe("fallback");
  });

  it("treats a missing file as empty and fails loudly on a required gap", () => {
    const env = createEnvReader({
      envFile: "/no/such/.env.local",
      processEnv: { PORT: "8080" },
    });
    expect(env.getNumber("PORT")).toBe(8080);
    expect(env.getNumber("NOPE")).toBeUndefined();
    expect(() => env.getRequired("DATABASE_URL")).toThrow(
      "Required environment variable DATABASE_URL is not set"
    );
  });

  it("parses KEY=value lines, keeping = inside values", () => {
    expect(parseEnvFile("URL=postgres://u:p@h/db?x=1\nbad line")).toEqual({
      URL: "postgres://u:p@h/db?x=1",
    });
  });
});

describe("createApiServer", () => {
  const server = (execute: () => Promise<ArrayLike<unknown>>) => {
    const routes = new Hono();
    routes.get("/ping", c => c.text("pong"));
    return createApiServer({
      name: "Test API",
      routes,
      db: { execute },
      initDatabase: async () => {},
      port: 1234,
      logger: silent,
    });
  };

  it("serves liveness, readiness and the API mount", async () => {
    const { app } = server(async () => [{ ok: 1 }]);
    expect(await (await app.request("/")).json()).toMatchObject({
      data: { name: "Test API", status: "healthy" },
    });
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/health/ready")).status).toBe(200);
    expect(await (await app.request("/api/v1/ping")).text()).toBe("pong");
  });

  it("reports not ready with 503 when the database does not answer", async () => {
    const { app } = server(async () => {
      throw new Error("connection refused");
    });
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "Database not ready: connection refused",
    });
  });

  it("rejects a body over the limit with 413", async () => {
    const routes = new Hono();
    routes.post("/echo", async c => c.text(await c.req.text()));
    const { app } = createApiServer({
      name: "Test API",
      routes,
      db: { execute: async () => [{}] },
      initDatabase: async () => {},
      port: 1,
      bodyLimitBytes: 10,
      logger: silent,
    });
    const res = await app.request("/api/v1/echo", {
      method: "POST",
      body: "x".repeat(100),
      headers: { "Content-Length": "100" },
    });
    expect(res.status).toBe(413);
  });

  it("lifts Bun's idle timeout for each request it serves", async () => {
    const { bunServer } = server(async () => [{}]);
    const timeout = vi.fn();
    await bunServer.fetch(new Request("http://localhost/health"), { timeout });
    expect(timeout).toHaveBeenCalledWith(expect.any(Request), 0);
    expect(bunServer.idleTimeout).toBe(255);
  });
});

describe("createLazyDatabase", () => {
  it("does not read the connection string until the database is used", () => {
    const connectionString = vi.fn(() => "postgresql://localhost:1/none");
    createLazyDatabase(connectionString, {});
    expect(connectionString).not.toHaveBeenCalled();
  });
});

describe("createFirebaseAuth", () => {
  it("rejects every token when disabled, without initializing Firebase", async () => {
    const auth = createFirebaseAuth({ enabled: false });
    await expect(auth.verifyIdToken("t")).rejects.toThrow("test mode");
  });

  it("refuses to enable without credentials", () => {
    expect(() => createFirebaseAuth({ enabled: true })).toThrow(
      "projectId, clientEmail and privateKey"
    );
  });
});

describe("invitation email", () => {
  it("escapes the entity name so it cannot inject markup", () => {
    const { html, subject } = renderInvitationEmail({
      productName: "ShapeRouter",
      entityName: '<a href="https://evil.example">Acme</a>\r\nBcc: x@y',
      appUrl: "https://shaperouter.ai",
    });
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(html).toContain("on ShapeRouter.");
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it("skips sending, with a warning, when Resend is not configured", async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sender = createInvitationEmailSender({
      productName: "ShapeShyft",
      logger,
    });
    await sender.sendInvitationEmail({
      recipientEmail: "a@b.c",
      entityName: "Acme",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Skipping invitation email — Resend not configured"
    );
  });
});
