import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { migrationStatementTable } from "./testing";

describe("migration statement targets", () => {
  test("recognises the statement shapes drizzle-kit and reviewed data migrations use", () => {
    expect(migrationStatementTable('CREATE TABLE "iap_account" (\n"id" uuid)')).toBe("iap_account");
    expect(migrationStatementTable('ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;')).toBe("account");
    expect(migrationStatementTable('CREATE UNIQUE INDEX "iap_account_user_uidx" ON "iap_account" USING btree ("user_id")')).toBe("iap_account");
    expect(migrationStatementTable('-- copy\nINSERT INTO "runtime_settings" ("scope") SELECT 1 FROM "operational_settings"')).toBe("runtime_settings");
    expect(migrationStatementTable('DROP INDEX "account_issuer_accountId_uidx";')).toBeNull();
    expect(migrationStatementTable("DO $$ BEGIN END $$;")).toBeNull();
  });

  test("every CREATE TABLE in the reviewed history is attributed to its table", () => {
    const creates = readMigrationFiles({ migrationsFolder: new URL("./migrations", import.meta.url).pathname })
      .flatMap((migration) => migration.sql)
      .map((statement) => statement.replace(/^--.*$/gm, "").trim())
      .filter((statement) => statement.startsWith("CREATE TABLE \"") && !statement.startsWith("CREATE TABLE \"mastra\""));
    expect(creates.length).toBeGreaterThan(0);
    for (const statement of creates) expect(migrationStatementTable(statement)).not.toBeNull();
  });
});
