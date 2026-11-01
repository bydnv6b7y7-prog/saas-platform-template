import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

dotenv.config({
  path: "../../apps/server/.env",
});

// Tables the product manages outside drizzle-kit (for example database-created partitions).
const productTablesFilter: string[] = JSON.parse(readFileSync("../product/drizzle.json", "utf8")).tablesFilter;

export default defineConfig({
  // Platform tables here; product tables live with the product (packages/product/src/schema).
  schema: ["./src/schema", "../product/src/schema"],
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
  ...(productTablesFilter.length ? { tablesFilter: productTablesFilter } : {}),
});
