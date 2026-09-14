/**
 * @fileoverview Entity API key header conventions
 * @description An entity key (`<prefix>_...`) authenticates a caller as the
 * *entity* rather than as a person: CI jobs, deployment scripts, and MCP clients
 * that must keep working when the member who created them leaves. Storage,
 * generation, and verification live in `@sudobility/entity_service`; this
 * module owns only the product's prefix and the header rules.
 *
 * Three other credentials exist and must not be confused with this one:
 *   - personal key (user prefix), authenticates a *user* (see user-api-key.ts)
 *   - `sk_live_...`  project key, authenticates callers of an AI endpoint
 *   - Firebase token browser session credential
 */

export function createEntityApiKeyFormat(prefix: string) {
  const prefixWithSeparator = `${prefix}_`;

  /**
   * Check whether a string looks like an entity API key for this product.
   * Used to route an incoming credential to entity auth instead of user auth.
   */
  function isEntityApiKeyFormat(value: string): boolean {
    return (
      value.startsWith(prefixWithSeparator) &&
      value.length > prefixWithSeparator.length
    );
  }

  /**
   * Extract an entity API key from request headers.
   *
   * Accepts `X-API-Key: <prefix>_...` (preferred, unambiguous) and
   * `Authorization: Bearer <prefix>_...`. Anything without the prefix is left
   * alone so it can be tried as a personal key or a Firebase ID token instead.
   *
   * @param getHeader Reads a request header by name, case-insensitively
   * @returns The key, or null when the request carries none
   */
  function extractEntityApiKeyFromHeaders(
    getHeader: (name: string) => string | undefined
  ): string | null {
    const headerKey = getHeader("X-API-Key");
    if (headerKey && isEntityApiKeyFormat(headerKey)) return headerKey;

    const authHeader = getHeader("Authorization");
    if (authHeader) {
      const [type, token] = authHeader.split(" ");
      if (type === "Bearer" && token && isEntityApiKeyFormat(token)) {
        return token;
      }
    }

    return null;
  }

  return {
    prefix,
    prefixWithSeparator,
    isEntityApiKeyFormat,
    extractEntityApiKeyFromHeaders,
  };
}

export type EntityApiKeyFormat = ReturnType<typeof createEntityApiKeyFormat>;
