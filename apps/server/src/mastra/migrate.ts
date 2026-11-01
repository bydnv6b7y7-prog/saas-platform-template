import "dotenv/config";

import { PostgresStore } from "@mastra/pg";

import { logInfo } from "../logging";
import { MASTRA_SCHEMA_NAME } from "./constants";
import { IDENTIFIER_PREFIX } from "@northwind/env/brand";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for Mastra migration.");

const storage = new PostgresStore({
  id: `${IDENTIFIER_PREFIX}-mastra-migration`,
  connectionString,
  schemaName: MASTRA_SCHEMA_NAME,
});

try {
  await storage.init();
  logInfo("mastra_migration_completed", { schema: MASTRA_SCHEMA_NAME });
} finally {
  await storage.close();
}
