/**
 * @fileoverview AES-256-CBC encryption for credentials at rest
 * @description The key is read through a getter on every call, so an app that
 * starts without ENCRYPTION_KEY fails on first use -- the behaviour
 * shapeshyft_api had when this read the environment directly.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16; // AES block size

export interface Encryption {
  /** Encrypt plain text; returns hex ciphertext and hex IV. */
  encryptApiKey(plainText: string): { encrypted: string; iv: string };
  /** Decrypt hex ciphertext with its hex IV. */
  decryptApiKey(encrypted: string, ivHex: string): string;
}

/**
 * @param getKeyHex Returns the 64-hex-character (32-byte) key. Called per operation.
 */
export function createEncryption(getKeyHex: () => string): Encryption {
  function key(): Buffer {
    const keyHex = getKeyHex();
    if (keyHex.length !== 64) {
      throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
    }
    return Buffer.from(keyHex, "hex");
  }

  return {
    encryptApiKey(plainText) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key(), iv);
      let encrypted = cipher.update(plainText, "utf8", "hex");
      encrypted += cipher.final("hex");
      return { encrypted, iv: iv.toString("hex") };
    },
    decryptApiKey(encrypted, ivHex) {
      const decipher = createDecipheriv(
        ALGORITHM,
        key(),
        Buffer.from(ivHex, "hex")
      );
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    },
  };
}

/** A new random key suitable for ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}
