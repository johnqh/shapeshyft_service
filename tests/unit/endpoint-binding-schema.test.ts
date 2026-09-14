import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createEndpointSchemas } from "../../src/schemas/index.js";

const base = { endpoint_name: "classify", display_name: "Classify" };

describe("createEndpointSchemas", () => {
  it("adds no binding fields by default", () => {
    const { endpointCreate } = createEndpointSchemas();
    expect(endpointCreate.safeParse(base).success).toBe(true);
  });

  it("requires a field the app's create binding requires", () => {
    const { endpointCreate } = createEndpointSchemas({
      create: { provider: z.enum(["openai", "anthropic"]) },
      update: { provider: z.enum(["openai", "anthropic"]).optional() },
    });
    const missing = endpointCreate.safeParse(base);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues[0]?.path).toEqual(["provider"]);
    }
    expect(
      endpointCreate.safeParse({ ...base, provider: "openai" }).success
    ).toBe(true);
  });

  it("keeps binding fields optional on update when the app says so", () => {
    const { endpointUpdate } = createEndpointSchemas({
      create: { llm_key_id: z.string().uuid() },
      update: { llm_key_id: z.string().uuid().optional() },
    });
    expect(endpointUpdate.safeParse({ display_name: "x" }).success).toBe(true);
  });
});
