import { describe, it, expect } from "vitest";
import { createEncryption } from "../../src/lib/encryption.js";
import { createUserApiKeys } from "../../src/lib/user-api-key.js";

const USER_API_KEY_PREFIX = "shyft_";
const {
  generateUserApiKey,
  hashUserApiKey,
  encryptUserApiKey,
  decryptUserApiKey,
  isUserApiKeyFormat,
  extractUserApiKeyFromHeaders,
} = createUserApiKeys({
  prefix: USER_API_KEY_PREFIX,
  encryption: createEncryption(() => "a".repeat(64)),
});

describe("user-api-key", () => {
  describe("generateUserApiKey", () => {
    it("should generate a key with the shyft_ prefix", () => {
      const { key } = generateUserApiKey();
      expect(key.startsWith(USER_API_KEY_PREFIX)).toBe(true);
    });

    it("should return a display prefix that matches the key", () => {
      const { key, prefix } = generateUserApiKey();
      expect(prefix).toHaveLength(14);
      expect(key.startsWith(prefix)).toBe(true);
    });

    it("should generate unique keys", () => {
      const keys = new Set(
        Array.from({ length: 100 }, () => generateUserApiKey().key)
      );
      expect(keys.size).toBe(100);
    });

    it("should be URL-safe (no padding or reserved characters)", () => {
      const { key } = generateUserApiKey();
      expect(key).toMatch(/^shyft_[A-Za-z0-9_-]+$/);
    });
  });

  describe("hashUserApiKey", () => {
    it("should produce a 64-character hex digest", () => {
      const { key } = generateUserApiKey();
      expect(hashUserApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should be deterministic", () => {
      const { key } = generateUserApiKey();
      expect(hashUserApiKey(key)).toBe(hashUserApiKey(key));
    });

    it("should differ for different keys", () => {
      expect(hashUserApiKey(generateUserApiKey().key)).not.toBe(
        hashUserApiKey(generateUserApiKey().key)
      );
    });

    it("should not be reversible to the key", () => {
      const { key } = generateUserApiKey();
      expect(hashUserApiKey(key)).not.toContain(
        key.slice(USER_API_KEY_PREFIX.length)
      );
    });
  });

  describe("encrypt/decrypt round trip", () => {
    it("should return the original key", () => {
      const { key } = generateUserApiKey();
      const { encrypted, iv } = encryptUserApiKey(key);
      expect(decryptUserApiKey(encrypted, iv)).toBe(key);
    });

    it("should produce different ciphertext for the same key (random IV)", () => {
      const { key } = generateUserApiKey();
      const a = encryptUserApiKey(key);
      const b = encryptUserApiKey(key);
      expect(a.encrypted).not.toBe(b.encrypted);
      expect(a.iv).not.toBe(b.iv);
      expect(decryptUserApiKey(a.encrypted, a.iv)).toBe(
        decryptUserApiKey(b.encrypted, b.iv)
      );
    });

    it("should not store the key in plain text", () => {
      const { key } = generateUserApiKey();
      const { encrypted } = encryptUserApiKey(key);
      expect(encrypted).not.toContain(key);
    });
  });

  describe("isUserApiKeyFormat", () => {
    it("should accept a generated key", () => {
      expect(isUserApiKeyFormat(generateUserApiKey().key)).toBe(true);
    });

    it("should reject the prefix alone", () => {
      expect(isUserApiKeyFormat(USER_API_KEY_PREFIX)).toBe(false);
    });

    it("should reject a project API key", () => {
      expect(isUserApiKeyFormat("sk_live_abcdef123456")).toBe(false);
    });

    it("should reject a Firebase ID token", () => {
      expect(
        isUserApiKeyFormat("eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.x.y")
      ).toBe(false);
    });

    it("should reject an empty string", () => {
      expect(isUserApiKeyFormat("")).toBe(false);
    });
  });

  describe("extractUserApiKeyFromHeaders", () => {
    const headers = (map: Record<string, string>) => (name: string) =>
      map[name];

    it("should read X-API-Key", () => {
      const { key } = generateUserApiKey();
      expect(extractUserApiKeyFromHeaders(headers({ "X-API-Key": key }))).toBe(
        key
      );
    });

    it("should read Authorization: Bearer", () => {
      const { key } = generateUserApiKey();
      expect(
        extractUserApiKeyFromHeaders(
          headers({ Authorization: `Bearer ${key}` })
        )
      ).toBe(key);
    });

    it("should prefer X-API-Key over Authorization", () => {
      const a = generateUserApiKey().key;
      const b = generateUserApiKey().key;
      expect(
        extractUserApiKeyFromHeaders(
          headers({ "X-API-Key": a, Authorization: `Bearer ${b}` })
        )
      ).toBe(a);
    });

    it("should ignore a Firebase token so it falls through to token auth", () => {
      expect(
        extractUserApiKeyFromHeaders(
          headers({ Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.body.sig" })
        )
      ).toBeNull();
    });

    it("should ignore a project API key", () => {
      expect(
        extractUserApiKeyFromHeaders(headers({ "X-API-Key": "sk_live_abc123" }))
      ).toBeNull();
    });

    it("should return null when no headers are present", () => {
      expect(extractUserApiKeyFromHeaders(headers({}))).toBeNull();
    });
  });
});
