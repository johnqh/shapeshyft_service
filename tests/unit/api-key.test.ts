import { describe, it, expect } from "vitest";
import { createEncryption } from "../../src/lib/encryption.js";
import { createProjectApiKeys } from "../../src/lib/api-key.js";

const {
  generateProjectApiKey,
  encryptProjectApiKey,
  decryptProjectApiKey,
  validateProjectApiKey,
  isValidApiKeyFormat,
} = createProjectApiKeys(
  createEncryption(
    () => "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  )
);

describe("API Key", () => {
  describe("generateProjectApiKey", () => {
    it("should generate a key with correct prefix", () => {
      const { key } = generateProjectApiKey();

      expect(key).toMatch(/^sk_live_/);
    });

    it("should generate a key longer than prefix", () => {
      const { key } = generateProjectApiKey();

      expect(key.length).toBeGreaterThan(8); // "sk_live_".length
    });

    it("should return a prefix of 12 characters", () => {
      const { prefix } = generateProjectApiKey();

      expect(prefix).toHaveLength(12);
      expect(prefix).toMatch(/^sk_live_/);
    });

    it("should generate unique keys", () => {
      const keys = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const { key } = generateProjectApiKey();
        keys.add(key);
      }

      expect(keys.size).toBe(100);
    });

    it("should generate keys with base64url characters", () => {
      const { key } = generateProjectApiKey();
      const randomPart = key.replace("sk_live_", "");

      // base64url uses A-Z, a-z, 0-9, -, _
      expect(randomPart).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe("encryptProjectApiKey / decryptProjectApiKey", () => {
    it("should encrypt and decrypt a key", () => {
      const { key } = generateProjectApiKey();
      const { encrypted, iv } = encryptProjectApiKey(key);
      const decrypted = decryptProjectApiKey(encrypted, iv);

      expect(decrypted).toBe(key);
    });

    it("should produce different encrypted values for same key", () => {
      const { key } = generateProjectApiKey();
      const result1 = encryptProjectApiKey(key);
      const result2 = encryptProjectApiKey(key);

      expect(result1.encrypted).not.toBe(result2.encrypted);
      expect(result1.iv).not.toBe(result2.iv);
    });
  });

  describe("validateProjectApiKey", () => {
    it("should return true for matching keys", () => {
      const { key } = generateProjectApiKey();
      const { encrypted, iv } = encryptProjectApiKey(key);

      expect(validateProjectApiKey(key, encrypted, iv)).toBe(true);
    });

    it("should return false for non-matching keys", () => {
      const { key: key1 } = generateProjectApiKey();
      const { key: key2 } = generateProjectApiKey();
      const { encrypted, iv } = encryptProjectApiKey(key1);

      expect(validateProjectApiKey(key2, encrypted, iv)).toBe(false);
    });

    it("should return false for tampered encrypted data", () => {
      const { key } = generateProjectApiKey();
      const { encrypted, iv } = encryptProjectApiKey(key);
      const tampered = "00" + encrypted.slice(2);

      expect(validateProjectApiKey(key, tampered, iv)).toBe(false);
    });

    it("should return false for invalid IV", () => {
      const { key } = generateProjectApiKey();
      const { encrypted } = encryptProjectApiKey(key);

      expect(validateProjectApiKey(key, encrypted, "invalidiv")).toBe(false);
    });

    it("should return false for different length keys", () => {
      const { key } = generateProjectApiKey();
      const { encrypted, iv } = encryptProjectApiKey(key);

      expect(validateProjectApiKey(key + "extra", encrypted, iv)).toBe(false);
    });
  });

  describe("isValidApiKeyFormat", () => {
    it("should return true for valid format", () => {
      expect(isValidApiKeyFormat("sk_live_abc123")).toBe(true);
      expect(isValidApiKeyFormat("sk_live_x")).toBe(true);
    });

    it("should return false for missing prefix", () => {
      expect(isValidApiKeyFormat("abc123")).toBe(false);
      expect(isValidApiKeyFormat("sk_test_abc")).toBe(false);
    });

    it("should return false for prefix only", () => {
      expect(isValidApiKeyFormat("sk_live_")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isValidApiKeyFormat("")).toBe(false);
    });

    it("should return true for generated keys", () => {
      for (let i = 0; i < 10; i++) {
        const { key } = generateProjectApiKey();
        expect(isValidApiKeyFormat(key)).toBe(true);
      }
    });
  });
});
