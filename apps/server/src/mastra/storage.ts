import { pool } from "@northwind/db";
import { env } from "@northwind/env/server";
import { PostgresStore } from "@mastra/pg";

import { MASTRA_SCHEMA_NAME } from "./constants";
import { IDENTIFIER_PREFIX } from "@northwind/env/brand";

export const mastraStorage = new PostgresStore({
  id: `${IDENTIFIER_PREFIX}-mastra-storage`,
  pool,
  schemaName: MASTRA_SCHEMA_NAME,
  // Only operational traces expire. Threads and messages remain product data.
  retention: {
    observability: {
      spans: { maxAge: `${env.MASTRA_TRACE_RETENTION_DAYS}d` },
    },
  },
  // Production migrations own DDL; request handling never mutates the schema.
  disableInit: true,
});
