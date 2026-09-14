import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Database-backed suites are never collected here; `bun run test:db` runs them.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.db.test.ts"],
    // The peer @sudobility services ship extensionless ESM imports that Node's
    // resolver rejects; inlining routes them through Vite, which accepts them.
    server: {
      deps: {
        inline: [
          "@sudobility/auth_service",
          "@sudobility/entity_service",
          "@sudobility/ratelimit_service",
          "@sudobility/subscription_service",
        ],
      },
    },
  },
});
