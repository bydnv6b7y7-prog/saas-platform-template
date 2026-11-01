import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { db } from "./index";
import * as schema from "./schema";

const migrationsFolder = new URL("./migrations", import.meta.url).pathname;

const TARGET = /^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: IF EXISTS)?(?: ONLY)?|INSERT INTO|UPDATE|DELETE FROM|DROP TABLE(?: IF EXISTS)?|TRUNCATE(?: TABLE)?|CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)?(?: IF NOT EXISTS)? "?[\w$]+"? ON(?: ONLY)?)\s+(?:"public"\.)?"?([\w$]+)"?/i;

/** The table a reviewed migration statement writes to, or null for statements this helper never applies. */
export function migrationStatementTable(statement: string): string | null {
  const sql = statement.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n").trim();
  return TARGET.exec(sql)?.[1] ?? null;
}

/**
 * Applies, in journal order, only the reviewed migration statements that write to `tables`.
 * Integration tests keep a minimal fixture schema (e.g. a one-column "user") and still exercise the
 * exact DDL a deployment applies, whether the history is this repository's or a regenerated baseline.
 */
export async function applyMigrationsFor(pool: Pick<pg.Pool, "query">, tables: readonly string[]): Promise<void> {
  const wanted = new Set(tables);
  for (const migration of readMigrationFiles({ migrationsFolder })) {
    for (const statement of migration.sql) {
      const table = migrationStatementTable(statement);
      if (table && wanted.has(table)) await pool.query(statement);
    }
  }
}

/** A pool and drizzle client for one dedicated test database, typed like the application's `db`. */
export function connectTestDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url });
  return { pool, db: drizzle({ client: pool, schema }) as unknown as typeof db };
}
