/**
 * @fileoverview User API key management
 * @description Generates, hashes, encrypts, and validates personal API keys.
 *
 * Keys use the format `<prefix><base64url-random>` (the prefix is configured
 * per product, e.g. `shyft_`) and are stored three ways:
 *   - `key_hash`   SHA-256 of the key, unique and indexed. Authentication looks
 *                  the key up by hash, so no decryption is needed on the hot path.
 *   - `encrypted_key` + `encryption_iv`  AES-256-CBC ciphertext, so the owner can
 *                  reveal the key again from the dashboard (same treatment
 *                  project API keys already get).
 *   - `key_prefix` First 14 characters, for display in lists.
 *
 * Distinct from the project API key (`sk_live_...`), which authenticates callers
 * of a published AI endpoint. A user API key authenticates the *owner* against
 * the admin routes, exactly as a Firebase ID token does.
 */

import { createHash, randomBytes } from "crypto";
import type { Encryption } from "./encryption.js";

/** Random bytes of entropy (32 bytes = 256 bits). */
const KEY_BYTES_LENGTH = 32;

/** Characters shown in listings, e.g. "shyft_ab12cd". */
const DISPLAY_PREFIX_LENGTH = 14;

/**
 * Hash a user API key for storage and lookup.
 * SHA-256 is appropriate here (rather than a slow password hash) because the key
 * is 256 bits of random data, not a guessable secret.
 * @param key The plain text API key
 * @returns Lowercase hex digest, 64 characters
 */
export function hashUserApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function createUserApiKeys(opts: {
  prefix: string;
  encryption: Encryption;
}) {
  const USER_API_KEY_PREFIX = opts.prefix;
  const { encryptApiKey, decryptApiKey } = opts.encryption;

  /**
   * Generate a new user API key.
   * @returns The full key and the prefix stored for display
   */
  function generateUserApiKey(): { key: string; prefix: string } {
    const randomPart = randomBytes(KEY_BYTES_LENGTH)
      .toString("base64url")
      .replace(/=/g, "");

    const key = `${USER_API_KEY_PREFIX}${randomPart}`;
    return { key, prefix: key.substring(0, DISPLAY_PREFIX_LENGTH) };
  }

  /**
   * Encrypt a user API key for at-rest storage.
   * @param key The plain text API key
   */
  function encryptUserApiKey(key: string): {
    encrypted: string;
    iv: string;
  } {
    return encryptApiKey(key);
  }

  /**
   * Decrypt a stored user API key so its owner can copy it again.
   * @param encrypted Hex ciphertext
   * @param iv Hex initialization vector
   */
  function decryptUserApiKey(encrypted: string, iv: string): string {
    return decryptApiKey(encrypted, iv);
  }

  /**
   * Check whether a string looks like a user API key.
   * Used to route an incoming credential to key auth instead of Firebase auth.
   */
  function isUserApiKeyFormat(value: string): boolean {
    return (
      value.startsWith(USER_API_KEY_PREFIX) &&
      value.length > USER_API_KEY_PREFIX.length
    );
  }

  /**
   * Extract a personal API key from request headers.
   *
   * Accepts `X-API-Key: <prefix>...` (preferred, unambiguous) and
   * `Authorization: Bearer <prefix>...`. Anything without the prefix is left
   * alone so it can be verified as a Firebase ID token instead.
   *
   * @param getHeader Reads a request header by name, case-insensitively
   * @returns The key, or null when the request carries none
   */
  function extractUserApiKeyFromHeaders(
    getHeader: (name: string) => string | undefined
  ): string | null {
    const headerKey = getHeader("X-API-Key");
    if (headerKey && isUserApiKeyFormat(headerKey)) return headerKey;

    const authHeader = getHeader("Authorization");
    if (authHeader) {
      const [type, token] = authHeader.split(" ");
      if (type === "Bearer" && token && isUserApiKeyFormat(token)) return token;
    }

    return null;
  }

  return {
    prefix: USER_API_KEY_PREFIX,
    generateUserApiKey,
    hashUserApiKey,
    encryptUserApiKey,
    decryptUserApiKey,
    isUserApiKeyFormat,
    extractUserApiKeyFromHeaders,
  };
}

export type UserApiKeys = ReturnType<typeof createUserApiKeys>;
