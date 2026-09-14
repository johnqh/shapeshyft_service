/** Unit-test setup: no database is reachable. */
import { scrubDatabaseUrl } from "@sudobility/test-db-guard";

process.env.NODE_ENV = "test";
scrubDatabaseUrl();
