import dotenv from "dotenv";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";

dotenv.config({
  path: new URL("../../../apps/server/.env", import.meta.url).pathname,
});

// Load the database module only after the server environment has been populated.
// Static imports are evaluated first and would make the documented local migration
// command fail env validation before dotenv gets a chance to run.
const { closeDb, db, rawQuery } = await import("../src/index");

const migrationsFolder = new URL("../src/migrations", import.meta.url).pathname;

async function baselinePushManagedDatabase() {
  const state = await rawQuery<{
    existing_schema: boolean;
    journal_exists: boolean;
  }>(
    `SELECT
       to_regclass('public.app_store_entries') IS NOT NULL AS existing_schema,
       to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS journal_exists`,
  );
  if (!state.rows[0]?.existing_schema) return;
  if (state.rows[0].journal_exists) {
    const journal = await rawQuery<{ count: number }>(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    );
    if ((journal.rows[0]?.count ?? 0) > 0) return;
  }

  const required = await rawQuery<{ complete: boolean }>(
    `SELECT
       to_regclass('public.user') IS NOT NULL
       AND to_regclass('public.app_store_entries') IS NOT NULL
       AND to_regclass('public.app_store_sync_runs') IS NOT NULL
       AND to_regclass('public.app_rank_snapshots') IS NOT NULL AS complete`,
  );
  if (!required.rows[0]?.complete) {
    throw new Error("Refusing to baseline an incomplete push-managed schema");
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  const initial = migrations[0];
  if (!initial) throw new Error("Initial migration is missing");
  await rawQuery("CREATE SCHEMA IF NOT EXISTS drizzle");
  await rawQuery(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id serial PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )`);
  await rawQuery(
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
     SELECT $1, $2
     WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations)`,
    [initial.hash, initial.folderMillis],
  );
  console.log(JSON.stringify({ event: "migration_baseline", migration: "0000" }));
}

try {
  await baselinePushManagedDatabase();
  await migrate(db, { migrationsFolder });
  console.log(JSON.stringify({ event: "migration_complete" }));
} finally {
  await closeDb();
}
