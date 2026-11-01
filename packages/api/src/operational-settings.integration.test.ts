import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { OPERATIONAL_SETTINGS_DEFAULTS } from "@northwind/env/operational-settings";

import type { Context } from "./context";

// Never run against DATABASE_URL. The child process loads the dedicated URL before
// any application singleton imports, so this suite also works alongside other tests.
const url = process.env.OPS_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/northwind_config_governance_test") {
    throw new Error("OPS_TEST_DATABASE_URL must reference the dedicated local northwind_config_governance_test database");
  }
  if (process.env.OPS_TEST_CHILD === "1" && process.env.DATABASE_URL !== url) {
    throw new Error("The integration child must use OPS_TEST_DATABASE_URL as DATABASE_URL");
  }
}

const migrationFile = (name: string) => Bun.file(new URL(`../../db/src/migrations/${name}.sql`, import.meta.url));
const migration = (name: string) => migrationFile(name).text();
// Only this repository's history has the legacy singleton; exported templates start from a baseline.
const hasLegacySettingsHistory = await migrationFile("0020_runtime_settings").exists();

if (!url || process.env.OPS_TEST_CHILD !== "1") {
  (url ? test : test.skip)("operational settings / real PostgreSQL", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        ...process.env,
        DATABASE_URL: url!,
        OPS_TEST_CHILD: "1",
        SKIP_ENV_VALIDATION: "",
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: "configuration-integration-test-secret",
        BETTER_AUTH_URL: "http://localhost:3000",
        CORS_ORIGIN: "http://localhost:3001",
        ADMIN_USER_IDS: "",
        MARKET_AI_ENABLED: "false",
        CONFIG_EDIT_ENABLED: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
  }, 30_000);
} else {
  describe("operational settings PostgreSQL transactions", () => {
    let connection: typeof import("@northwind/db");
    let settings: typeof import("./operational-settings");
    let config: typeof import("./routers/config");

    beforeAll(async () => {
      connection = await import("@northwind/db");
      settings = await import("./operational-settings");
      config = await import("./routers/config");
      const exists = await connection.pool.query("SELECT to_regclass('public.runtime_settings') AS name");
      if (!exists.rows[0].name) {
        const { applyMigrationsFor } = await import("@northwind/db/testing");
        // The legacy tables exist only in histories that predate 0020; it copies from them.
        await applyMigrationsFor(connection.pool, ["operational_settings", "operational_settings_audit", "runtime_settings", "runtime_settings_audit"]);
      }
      await connection.pool.query('CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY)');
    });
    beforeEach(async () => {
      await connection.pool.query('TRUNCATE runtime_settings, runtime_settings_audit, "user"');
    });
    afterAll(async () => { await connection.pool.end(); });

    const store = (lookup = 50) => settings.createOperationalSettingsStore(connection.db, () => ({
      ...OPERATIONAL_SETTINGS_DEFAULTS,
      assistantProPerDay: lookup,
    }));
    const changed = (lookup = 60) => ({ ...OPERATIONAL_SETTINGS_DEFAULTS, assistantProPerDay: lookup });

    test("deployment fallback is exact, uncached, and superseded by the full database snapshot", async () => {
      expect(await store(200).read()).toMatchObject({ values: changed(200), revision: 0, source: "deployment", updatedAt: null });
      const next = await store(200).update({ expectedRevision: 0, values: changed(), actorId: "operator" });
      expect(next).toMatchObject({ values: changed(), revision: 1, source: "database", updatedBy: "operator" });
      expect(await store(999).read()).toEqual(next);
      const strict = settings.createOperationalSettingsStore(connection.db, () => { throw new Error("must not read deployment values"); });
      expect(await strict.read()).toEqual(next);
      expect(await store().history()).toEqual([{
        revision: 1, actorId: "operator", createdAt: next.updatedAt!, before: changed(200), after: changed(),
      }]);
    });

    test("simultaneous first saves have exactly one winner and one audited revision", async () => {
      const results = await Promise.allSettled([
        store().update({ expectedRevision: 0, values: changed(60), actorId: "alice" }),
        store().update({ expectedRevision: 0, values: changed(70), actorId: "bob" }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
      expect((await store().read()).revision).toBe(1);
      expect(await store().history()).toHaveLength(1);
    });

    test("no-op saves never write; stale saves cannot bypass revision validation", async () => {
      expect(await store().update({ expectedRevision: 0, values: changed(50), actorId: "alice" }))
        .toMatchObject({ revision: 0, source: "deployment" });
      expect(await store().history()).toEqual([]);
      const next = await store().update({ expectedRevision: 0, values: changed(), actorId: "alice" });
      expect(await store().update({ expectedRevision: 1, values: changed(), actorId: "bob" })).toEqual(next);
      await expect(store().update({ expectedRevision: 0, values: changed(), actorId: "bob" }))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(await store().history()).toHaveLength(1);
    });

    test("concurrent edits after initialization cannot overwrite an unseen revision", async () => {
      await store().update({ expectedRevision: 0, values: changed(), actorId: "alice" });
      const results = await Promise.allSettled([
        store().update({ expectedRevision: 1, values: changed(70), actorId: "alice" }),
        store().update({ expectedRevision: 1, values: changed(80), actorId: "bob" }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
      expect((await store().read()).revision).toBe(2);
      expect(await store().history()).toHaveLength(2);
    });

    test("audit failures roll back both initial and subsequent snapshot writes", async () => {
      await connection.pool.query("ALTER TABLE runtime_settings_audit ADD CONSTRAINT test_audit_failure CHECK (actor_id <> 'fail-audit')");
      try {
        await expect(store().update({ expectedRevision: 0, values: changed(), actorId: "fail-audit" })).rejects.toThrow();
        expect((await store().read()).revision).toBe(0);
        expect(await store().history()).toEqual([]);
        const next = await store().update({ expectedRevision: 0, values: changed(), actorId: "alice" });
        await expect(store().update({ expectedRevision: 1, values: changed(70), actorId: "fail-audit" })).rejects.toThrow();
        expect(await store().read()).toEqual(next);
        expect(await store().history()).toHaveLength(1);
      } finally {
        await connection.pool.query("ALTER TABLE runtime_settings_audit DROP CONSTRAINT test_audit_failure");
      }
    });

    test("actor IDs survive account deletion and history returns only the latest 20 changes", async () => {
      await connection.pool.query('INSERT INTO "user" (id) VALUES (\'operator\')');
      for (let revision = 0; revision < 21; revision++) {
        await store().update({ expectedRevision: revision, values: changed(60 + revision), actorId: "operator" });
      }
      await connection.pool.query('DELETE FROM "user" WHERE id = \'operator\'');
      expect((await store().read()).updatedBy).toBe("operator");
      const history = await store().history();
      expect(history).toHaveLength(20);
      expect(history.map((row) => row.revision)).toEqual(Array.from({ length: 20 }, (_, index) => 21 - index));
      expect(history.every((row) => row.actorId === "operator")).toBe(true);
    });

    test.skipIf(!hasLegacySettingsHistory)("0020 splits legacy singleton rows into operations and ingest scopes without losing history", async () => {
      const client = await connection.pool.connect();
      try {
        await client.query("DROP SCHEMA IF EXISTS settings_split_test CASCADE; CREATE SCHEMA settings_split_test; SET search_path TO settings_split_test");
        await client.query(await migration("0013_operational_settings"));
        const limits = { assistantFreePer5Minutes: 5, assistantFreePerDay: 5, assistantProPer5Minutes: 10, assistantProPerDay: 100 };
        const v = (proDay: number, lookup: number) => JSON.stringify({ ...limits, assistantProPerDay: proDay, ingestLookupLimit: lookup, ingestReviewsLimit: 25 });
        await client.query(`INSERT INTO operational_settings_audit (revision, actor_id, created_at, before, after) VALUES
          (1, 'alice', '2026-01-01T00:00:00Z', $1, $2),
          (2, 'bob',   '2026-01-02T00:00:00Z', $2, $3),
          (3, 'carol', '2026-01-03T00:00:00Z', $3, $4)`, [v(100, 50), v(120, 50), v(120, 80), v(150, 90)]);
        await client.query("INSERT INTO operational_settings (id, values, revision, updated_at, updated_by) VALUES (1, $1, 3, '2026-01-03T00:00:00Z', 'carol')", [v(150, 90)]);
        await client.query(await migration("0020_runtime_settings"));

        const rows = (await client.query("SELECT scope, values, revision, updated_by FROM runtime_settings ORDER BY scope")).rows;
        expect(rows).toEqual([
          { scope: "ingest", values: { lookupLimit: 90, reviewsLimit: 25 }, revision: 2, updated_by: "carol" },
          { scope: "operations", values: { ...limits, assistantProPerDay: 150 }, revision: 3, updated_by: "carol" },
        ]);
        const audit = (await client.query("SELECT scope, revision, actor_id, before, after FROM runtime_settings_audit ORDER BY scope, revision")).rows;
        expect(audit.map((row) => [row.scope, row.revision, row.actor_id])).toEqual([
          ["ingest", 1, "bob"], ["ingest", 2, "carol"], ["operations", 1, "alice"], ["operations", 3, "carol"],
        ]);
        expect(audit[1]).toMatchObject({ before: { lookupLimit: 80, reviewsLimit: 25 }, after: { lookupLimit: 90, reviewsLimit: 25 } });
        expect(audit[3]!.after).toEqual({ ...limits, assistantProPerDay: 150 });
        // The previous release keeps reading the legacy singleton until it is replaced.
        expect((await client.query("SELECT revision FROM operational_settings")).rows).toEqual([{ revision: 3 }]);
      } finally {
        await client.query("RESET search_path; DROP SCHEMA IF EXISTS settings_split_test CASCADE");
        client.release();
      }
    });

    test("platform admin operations work without any product config procedures", async () => {
      const { router } = await import("./index");
      const caller = router(config.platformConfigRouters).createCaller({
        auth: null, ip: "test", session: { user: { id: "operator", role: "admin" } } as Context["session"],
      });
      const current = await caller.operations.overview();
      expect(current.defaults).toEqual(OPERATIONAL_SETTINGS_DEFAULTS);
      const next = await caller.operations.update({ expectedRevision: current.revision, values: changed(99) });
      expect(next).toMatchObject({ revision: 1, source: "database", updatedBy: "operator" });
      expect(await caller.operations.history()).toHaveLength(1);
    });
  });
}
