/**
 * @fileoverview In-process cache for user API key lookups.
 *
 * Every request authenticated with a personal API key would otherwise pay a
 * database round-trip before the handler does its own work. Keys change rarely,
 * so the resolved identity is cached for a short window.
 *
 * Only SUCCESSFUL lookups are cached: an unknown key re-checks the database
 * every time, so a key created moments ago works immediately and a bogus key can
 * never be pinned in memory. The short TTL bounds how long a *revoked* key keeps
 * working — deleting or deactivating a key takes effect within
 * `KEY_CACHE_TTL_MS`, and `invalidateUserApiKeyCache` clears it immediately when
 * the revocation goes through this API.
 */

import { eq, and } from "drizzle-orm";
import type { Logger, ServiceDb } from "../contracts.js";
import type { ServiceTables } from "../schema/tables.js";

const KEY_CACHE_TTL_MS = 60_000;

/** How stale `last_used_at` may get before we write it again. */
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

export interface ResolvedApiKeyUser {
  /** Firebase UID of the key's owner — used exactly like a token's uid */
  userId: string;
  /** Owner's email, or null when the user record has none */
  userEmail: string | null;
  /** UUID of the API key row itself */
  keyId: string;
}

interface CacheEntry extends ResolvedApiKeyUser {
  expiresAt: number;
  lastUsedWrittenAt: number;
}

export function createUserApiKeyCache(opts: {
  db: ServiceDb;
  tables: Pick<ServiceTables, "userApiKeys" | "users">;
  hashUserApiKey: (key: string) => string;
  logger: Logger;
}) {
  const { db, hashUserApiKey, logger } = opts;
  const { userApiKeys, users } = opts.tables;
  const cache = new Map<string, CacheEntry>();

  /**
   * Resolve a plain text user API key to the identity it authenticates.
   * @param key The personal key value from the request
   * @returns The owner's identity, or null when the key is unknown or inactive
   */
  async function resolveUserApiKey(
    key: string
  ): Promise<ResolvedApiKeyUser | null> {
    const now = Date.now();
    const hash = hashUserApiKey(key);

    const cached = cache.get(hash);
    if (cached && cached.expiresAt > now) {
      void touchLastUsed(hash, cached, now);
      return {
        userId: cached.userId,
        userEmail: cached.userEmail,
        keyId: cached.keyId,
      };
    }

    const rows = await db
      .select({
        keyId: userApiKeys.uuid,
        userId: userApiKeys.firebase_uid,
        userEmail: users.email,
      })
      .from(userApiKeys)
      .leftJoin(users, eq(users.firebase_uid, userApiKeys.firebase_uid))
      .where(
        and(eq(userApiKeys.key_hash, hash), eq(userApiKeys.is_active, true))
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      cache.delete(hash);
      return null;
    }

    const resolved: ResolvedApiKeyUser = {
      userId: row.userId,
      userEmail: row.userEmail ?? null,
      keyId: row.keyId,
    };

    cache.set(hash, {
      ...resolved,
      expiresAt: now + KEY_CACHE_TTL_MS,
      lastUsedWrittenAt: 0,
    });

    void touchLastUsed(hash, cache.get(hash)!, now);

    return resolved;
  }

  /**
   * Record that a key was used, at most once per LAST_USED_WRITE_INTERVAL_MS.
   * Fire-and-forget: a failed bookkeeping write must never fail the request.
   */
  async function touchLastUsed(
    hash: string,
    entry: CacheEntry,
    now: number
  ): Promise<void> {
    if (now - entry.lastUsedWrittenAt < LAST_USED_WRITE_INTERVAL_MS) return;
    entry.lastUsedWrittenAt = now;

    try {
      await db
        .update(userApiKeys)
        .set({ last_used_at: new Date(now) })
        .where(eq(userApiKeys.uuid, entry.keyId));
    } catch (error) {
      logger.error("Failed to update user API key last_used_at:", error);
    }
  }

  /**
   * Drop a key from the cache so a revocation or rename takes effect at once.
   * @param keyHash The stored SHA-256 hash, or undefined to clear everything
   */
  function invalidateUserApiKeyCache(keyHash?: string): void {
    if (keyHash) {
      cache.delete(keyHash);
      return;
    }
    cache.clear();
  }

  return { resolveUserApiKey, invalidateUserApiKeyCache };
}

export type UserApiKeyCache = ReturnType<typeof createUserApiKeyCache>;
