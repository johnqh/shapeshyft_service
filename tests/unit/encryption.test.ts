import { describe, it, expect } from "vitest";
import {
  createEncryption,
  generateEncryptionKey,
} from "../../src/lib/encryption.js";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const { encryptApiKey, decryptApiKey } = createEncryption(() => TEST_KEY);

describe("createEncryption key validation", () => {
  it("rejects a key that is not 64 hex characters, on first use", () => {
    const bad = createEncryption(() => "short");
    expect(() => bad.encryptApiKey("x")).toThrow(
      "ENCRYPTION_KEY must be 64 hex characters (32 bytes)"
    );
  });
});

describe("Encryption", () => {
  describe("encryptApiKey", () => {
    it("should encrypt a plain text API key", () => {
      const plainText = "sk-test-key-123";
      const result = encryptApiKey(plainText);

      expect(result).toHaveProperty("encrypted");
      expect(result).toHaveProperty("iv");
      expect(result.encrypted).not.toBe(plainText);
      expect(result.iv).toHaveLength(32); // 16 bytes as hex = 32 chars
    });

    it("should produce different IVs for same input", () => {
      const plainText = "sk-same-key";
      const result1 = encryptApiKey(plainText);
      const result2 = encryptApiKey(plainText);

      expect(result1.iv).not.toBe(result2.iv);
      expect(result1.encrypted).not.toBe(result2.encrypted);
    });

    it("should handle empty string", () => {
      const result = encryptApiKey("");

      expect(result.encrypted).toBeDefined();
      expect(result.iv).toBeDefined();
    });

    it("should handle long strings", () => {
      const longKey = "sk-" + "a".repeat(1000);
      const result = encryptApiKey(longKey);

      expect(result.encrypted).toBeDefined();
      expect(result.encrypted.length).toBeGreaterThan(1000);
    });

    it("should handle special characters", () => {
      const specialKey = "sk-test!@#$%^&*()_+-={}[]|:;<>?,./~`";
      const result = encryptApiKey(specialKey);

      expect(result.encrypted).toBeDefined();
      expect(result.iv).toBeDefined();
    });
  });

  describe("decryptApiKey", () => {
    it("should decrypt an encrypted API key", () => {
      const plainText = "sk-test-key-456";
      const { encrypted, iv } = encryptApiKey(plainText);
      const decrypted = decryptApiKey(encrypted, iv);

      expect(decrypted).toBe(plainText);
    });

    it("should decrypt empty string", () => {
      const { encrypted, iv } = encryptApiKey("");
      const decrypted = decryptApiKey(encrypted, iv);

      expect(decrypted).toBe("");
    });

    it("should decrypt long strings", () => {
      const longKey = "sk-" + "b".repeat(500);
      const { encrypted, iv } = encryptApiKey(longKey);
      const decrypted = decryptApiKey(encrypted, iv);

      expect(decrypted).toBe(longKey);
    });

    it("should decrypt special characters", () => {
      const specialKey = "sk-special!@#$%éàü中文🎉";
      const { encrypted, iv } = encryptApiKey(specialKey);
      const decrypted = decryptApiKey(encrypted, iv);

      expect(decrypted).toBe(specialKey);
    });

    it("should throw on invalid IV", () => {
      const { encrypted } = encryptApiKey("test");

      expect(() => decryptApiKey(encrypted, "invalid")).toThrow();
    });

    it("should throw on tampered encrypted data", () => {
      const { encrypted, iv } = encryptApiKey("test");
      // Drop the last byte. Overwriting it instead is flaky: the garbled final
      // block still ends in valid PKCS7 padding about 1 time in 256, so
      // decryption succeeds and nothing is thrown. A ciphertext that is not a
      // whole number of blocks always fails.
      const tampered = encrypted.slice(0, -2);

      expect(() => decryptApiKey(tampered, iv)).toThrow();
    });
  });

  describe("generateEncryptionKey", () => {
    it("should generate a 64-character hex string", () => {
      const key = generateEncryptionKey();

      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[0-9a-f]+$/);
    });

    it("should generate unique keys", () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();

      expect(key1).not.toBe(key2);
    });
  });

  describe("round-trip encryption", () => {
    it("should encrypt and decrypt multiple keys correctly", () => {
      const keys = [
        "sk-openai-test-123",
        "sk-ant-api-key-456",
        "AIzaSy-gemini-key-789",
        "custom-llm-server-key",
      ];

      for (const key of keys) {
        const { encrypted, iv } = encryptApiKey(key);
        const decrypted = decryptApiKey(encrypted, iv);
        expect(decrypted).toBe(key);
      }
    });
  });
});
