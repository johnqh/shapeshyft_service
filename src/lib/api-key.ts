/**
 * @fileoverview Project API key management
 * @description Generates, encrypts, decrypts, and validates project API keys.
 * Keys use the format `sk_live_<base64url-random>` and are validated
 * using timing-safe comparison to prevent timing attacks.
 */

import { randomBytes, timingSafeEqual } from "crypto";
import type { Encryption } from "./encryption.js";

// API Key prefix for identification
const API_KEY_PREFIX = "sk_live_";

// Random bytes of entropy (32 bytes = 256 bits)
const KEY_BYTES_LENGTH = 32;

export function createProjectApiKeys(encryption: Encryption) {
  const { encryptApiKey, decryptApiKey } = encryption;

  /**
   * Generate a new API key with prefix
   * Format: sk_live_<base64url-encoded-random-bytes>
   * @returns Object with full key and prefix for display
   */
  function generateProjectApiKey(): {
    key: string;
    prefix: string;
  } {
    const randomPart = randomBytes(KEY_BYTES_LENGTH)
      .toString("base64url")
      .replace(/[=]/g, ""); // Remove padding

    const fullKey = `${API_KEY_PREFIX}${randomPart}`;
    // Prefix shows first 12 characters (sk_live_ + first 4 random chars)
    const prefix = fullKey.substring(0, 12);

    return {
      key: fullKey,
      prefix,
    };
  }

  /**
   * Encrypt a project API key for storage
   * @param key The plain text API key
   * @returns Object with encrypted value and IV
   */
  function encryptProjectApiKey(key: string): {
    encrypted: string;
    iv: string;
  } {
    return encryptApiKey(key);
  }

  /**
   * Decrypt a stored project API key
   * @param encrypted The encrypted API key (hex string)
   * @param iv The initialization vector (hex string)
   * @returns The decrypted plain text API key
   */
  function decryptProjectApiKey(encrypted: string, iv: string): string {
    return decryptApiKey(encrypted, iv);
  }

  /**
   * Validate a provided API key against an encrypted stored key
   * Uses timing-safe comparison to prevent timing attacks
   * @param providedKey The API key provided by the caller
   * @param encryptedKey The encrypted stored API key
   * @param iv The IV used for encryption
   * @returns true if keys match, false otherwise
   */
  function validateProjectApiKey(
    providedKey: string,
    encryptedKey: string,
    iv: string
  ): boolean {
    try {
      const storedKey = decryptProjectApiKey(encryptedKey, iv);

      // Use timing-safe comparison
      const providedBuffer = Buffer.from(providedKey, "utf8");
      const storedBuffer = Buffer.from(storedKey, "utf8");

      if (providedBuffer.length !== storedBuffer.length) {
        return false;
      }

      return timingSafeEqual(providedBuffer, storedBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Check if a string looks like a valid API key format
   * @param key The string to check
   * @returns true if format is valid
   */
  function isValidApiKeyFormat(key: string): boolean {
    return key.startsWith(API_KEY_PREFIX) && key.length > API_KEY_PREFIX.length;
  }

  return {
    generateProjectApiKey,
    encryptProjectApiKey,
    decryptProjectApiKey,
    validateProjectApiKey,
    isValidApiKeyFormat,
  };
}

export type ProjectApiKeys = ReturnType<typeof createProjectApiKeys>;
