import "dotenv/config";

import { PostgresStore } from "@mastra/pg";

import { logInfo } from "../logging";
import { MASTRA_SCHEMA_NAME } from "./constants";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for Mastra migration.");

const storage = new PostgresStore({
  id: "northwind-mastra-migration",
  connectionString,
  schemaName: MASTRA_SCHEMA_NAME,
});

try {
  await storage.init();
  logInfo("mastra_migration_completed", { schema: MASTRA_SCHEMA_NAME });
} finally {
  await storage.close();
}
