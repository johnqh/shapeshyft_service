import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.db.ts"],
    include: ["tests/**/*.db.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // One database, shared across files. Parallel files corrupt each other.
    fileParallelism: false,
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
