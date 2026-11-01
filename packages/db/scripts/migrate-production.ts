import dotenv from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";

dotenv.config({
  path: new URL("../../../apps/server/.env", import.meta.url).pathname,
});

// Load the database module only after the server environment has been populated.
// Static imports are evaluated first and would make the documented local migration
// command fail env validation before dotenv gets a chance to run.
const { closeDb, db } = await import("../src/index");

const migrationsFolder = new URL("../src/migrations", import.meta.url).pathname;

try {
  await migrate(db, { migrationsFolder });
  console.log(JSON.stringify({ event: "migration_complete" }));
} finally {
  await closeDb();
}
