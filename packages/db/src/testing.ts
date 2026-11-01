import { readMigrationFiles } from "drizzle-orm/migrator";
import type pg from "pg";

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
