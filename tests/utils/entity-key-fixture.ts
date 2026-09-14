import { createEntityApiKeyFormat } from "../../src/lib/entity-api-key.js";

/** ShapeShyft's entity key format, so the ported cases keep their exact values. */
const format = createEntityApiKeyFormat("shyftent");

export const ENTITY_API_KEY_PREFIX = format.prefix;
export const ENTITY_API_KEY_PREFIX_WITH_SEPARATOR = format.prefixWithSeparator;
export const { isEntityApiKeyFormat, extractEntityApiKeyFromHeaders } = format;
