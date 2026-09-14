/**
 * A project as a caller should see it.
 *
 * `db.select()` returns every column, which for a project includes the
 * ENCRYPTED api key and its IV. Encrypted is not the same as safe to hand out:
 * ciphertext plus IV is strictly more than a caller needs, and identifying a
 * project is what `api_key_prefix` is for. The invocation path reads the real
 * columns from its own query, so nothing depends on them being in a response.
 *
 * Its own module rather than the route file so it can be tested without
 * importing the whole HTTP surface.
 */
export function publicProject<T extends Record<string, unknown>>(row: T) {
  const { encrypted_api_key: _e, api_key_iv: _i, ...rest } = row;
  return rest;
}
