import { describe, it, expect } from "vitest";
import {
  isEntityApiKeyFormat,
  extractEntityApiKeyFromHeaders,
  ENTITY_API_KEY_PREFIX,
  ENTITY_API_KEY_PREFIX_WITH_SEPARATOR,
} from "../utils/entity-key-fixture.js";
import { createEncryption } from "../../src/lib/encryption.js";
import { createUserApiKeys } from "../../src/lib/user-api-key.js";

const { isUserApiKeyFormat, extractUserApiKeyFromHeaders } = createUserApiKeys({
  prefix: "shyft_",
  encryption: createEncryption(() => "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
});

const entityKey = `${ENTITY_API_KEY_PREFIX_WITH_SEPARATOR}abc123def456`;
const personalKey = "shyft_abc123def456";

describe("entity-api-key", () => {
  describe("isEntityApiKeyFormat", () => {
    it("should accept a key with the shyftent_ prefix", () => {
      expect(isEntityApiKeyFormat(entityKey)).toBe(true);
    });

    it("should reject the bare prefix with no secret", () => {
      expect(isEntityApiKeyFormat(ENTITY_API_KEY_PREFIX_WITH_SEPARATOR)).toBe(
        false
      );
    });

    it("should reject a personal API key", () => {
      expect(isEntityApiKeyFormat(personalKey)).toBe(false);
    });

    it("should reject a Firebase token", () => {
      expect(isEntityApiKeyFormat("eyJhbGciOiJSUzI1NiIs")).toBe(false);
    });
  });

  describe("prefix isolation", () => {
    // The two key types share a stem; a request must never be routed to the
    // wrong verifier because one prefix is a substring of the other.
    it("should not classify an entity key as a personal key", () => {
      expect(isUserApiKeyFormat(entityKey)).toBe(false);
    });

    it("should not classify a personal key as an entity key", () => {
      expect(isEntityApiKeyFormat(personalKey)).toBe(false);
    });

    it("should keep the prefixes distinct", () => {
      expect(ENTITY_API_KEY_PREFIX).toBe("shyftent");
      expect(ENTITY_API_KEY_PREFIX_WITH_SEPARATOR.startsWith("shyft_")).toBe(
        false
      );
    });
  });

  describe("extractEntityApiKeyFromHeaders", () => {
    it("should read the key from X-API-Key", () => {
      const headers: Record<string, string> = { "X-API-Key": entityKey };
      expect(extractEntityApiKeyFromHeaders(name => headers[name])).toBe(
        entityKey
      );
    });

    it("should read the key from Authorization: Bearer", () => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${entityKey}`,
      };
      expect(extractEntityApiKeyFromHeaders(name => headers[name])).toBe(
        entityKey
      );
    });

    it("should return null for a personal key", () => {
      const headers: Record<string, string> = { "X-API-Key": personalKey };
      expect(extractEntityApiKeyFromHeaders(name => headers[name])).toBeNull();
    });

    it("should return null for a Firebase token", () => {
      const headers: Record<string, string> = {
        Authorization: "Bearer eyJhbGciOiJSUzI1NiIs",
      };
      expect(extractEntityApiKeyFromHeaders(name => headers[name])).toBeNull();
    });

    it("should return null when no credential is present", () => {
      expect(extractEntityApiKeyFromHeaders(() => undefined)).toBeNull();
    });

    it("should not steal a personal key from the personal extractor", () => {
      const headers: Record<string, string> = { "X-API-Key": personalKey };
      expect(extractUserApiKeyFromHeaders(name => headers[name])).toBe(
        personalKey
      );
      expect(extractEntityApiKeyFromHeaders(name => headers[name])).toBeNull();
    });
  });
});
