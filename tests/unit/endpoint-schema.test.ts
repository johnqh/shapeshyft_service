import { describe, it, expect } from "vitest";
import { z } from "zod";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "@sudobility/shapeshyft_engine/types";
import { createEndpointSchemas } from "../../src/schemas/index.js";

// ShapeShyft's binding, so these cases validate exactly what they did in shapeshyft_api.
const {
  endpointCreate: endpointCreateSchema,
  endpointUpdate: endpointUpdateSchema,
} = createEndpointSchemas({
  create: { llm_key_id: z.string().uuid() },
  update: { llm_key_id: z.string().uuid().optional() },
});

const base = {
  endpoint_name: "analyze-text",
  display_name: "Analyze Text",
  llm_key_id: "123e4567-e89b-12d3-a456-426614174000",
};

describe("endpoint schemas: output ceiling", () => {
  describe("create", () => {
    it("protects a new endpoint by default when the field is omitted", () => {
      const parsed = endpointCreateSchema.parse(base);
      expect(parsed.max_output_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });

    it("lets an operator opt out with an explicit null", () => {
      const parsed = endpointCreateSchema.parse({
        ...base,
        max_output_tokens: null,
      });
      expect(parsed.max_output_tokens).toBeNull();
    });

    it("keeps an explicit ceiling", () => {
      const parsed = endpointCreateSchema.parse({
        ...base,
        max_output_tokens: 500,
      });
      expect(parsed.max_output_tokens).toBe(500);
    });

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["fractional", 12.5],
      ["absurdly large", 5_000_000],
    ])("rejects %s", (_label, value) => {
      expect(() =>
        endpointCreateSchema.parse({ ...base, max_output_tokens: value })
      ).toThrow();
    });
  });

  describe("update", () => {
    it("leaves the ceiling unchanged when the field is omitted", () => {
      const parsed = endpointUpdateSchema.parse({ display_name: "New" });
      expect(parsed.max_output_tokens).toBeUndefined();
    });

    it("removes the ceiling on an explicit null", () => {
      const parsed = endpointUpdateSchema.parse({ max_output_tokens: null });
      expect(parsed.max_output_tokens).toBeNull();
    });

    it("does not silently apply the default on update", () => {
      // An existing unprotected endpoint must stay unprotected unless the
      // operator says otherwise -- update must never re-cap it behind their back.
      const parsed = endpointUpdateSchema.parse({ instructions: "hi" });
      expect("max_output_tokens" in parsed).toBe(false);
    });
  });
});
