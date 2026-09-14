/**
 * DB-test setup. Throws unless TEST_DATABASE_URL names a localhost database,
 * then publishes it as DATABASE_URL.
 */
import { setupTestDatabase } from "@sudobility/test-db-guard";

process.env.NODE_ENV = "test";
setupTestDatabase();
