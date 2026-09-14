import { pgSchema } from "drizzle-orm/pg-core";
import {
  buildContext,
  type ShapeshyftServiceConfig,
} from "../../src/context.js";
import { createServiceTables } from "../../src/schema/tables.js";
import { createEncryption } from "../../src/lib/encryption.js";
import type { ProviderCredentialResolver } from "../../src/contracts.js";

export const TEST_ENCRYPTION = createEncryption(
  () => "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
);

export const unusedResolver: ProviderCredentialResolver = {
  bindEndpoint: async () => {
    throw new Error("bindEndpoint not expected in this test");
  },
  resolve: async () => {
    throw new Error("resolve not expected in this test");
  },
};

/** A config whose db fails on any query: for tests that must not reach the DB. */
export function offlineConfig(
  overrides: Partial<ShapeshyftServiceConfig> = {}
): ShapeshyftServiceConfig {
  // Property reads succeed (helpers may capture `db.select` at construction);
  // any call fails, so a query in an offline test is loud.
  const noDb = new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error("database access not expected in this test");
        };
      },
    }
  );
  return {
    db: noDb as any,
    tables: createServiceTables(pgSchema("offline"), {
      indexPrefix: "offline",
    }),
    keyPrefixes: { user: "shyft_", entity: "shyftent" },
    encryption: TEST_ENCRYPTION,
    auth: {
      verifyIdToken: async () => {
        throw new Error("invalid token");
      },
      isSiteAdmin: () => false,
      isAnonymousUser: () => false,
      getUserInfo: async () => {
        throw new Error("getUserInfo not expected");
      },
    } as any,
    email: { sendInvitationEmail: async () => {} },
    credentials: unusedResolver,
    ...overrides,
  };
}

export function offlineContext(
  overrides: Partial<ShapeshyftServiceConfig> = {}
) {
  return buildContext(offlineConfig(overrides));
}
