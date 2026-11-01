import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AppStoreAdminConfiguration } from "./app-store-admin";

// This suite writes only to a separately provisioned local database, never DATABASE_URL.
const url = process.env.IAP_ADMIN_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/northwind_iap_admin_test") {
    throw new Error("IAP_ADMIN_TEST_DATABASE_URL must reference the dedicated local northwind_iap_admin_test database");
  }
  if (process.env.IAP_ADMIN_TEST_CHILD === "1" && process.env.DATABASE_URL !== url) {
    throw new Error("The integration child must use the dedicated test database");
  }
}

if (!url || process.env.IAP_ADMIN_TEST_CHILD !== "1") {
  (url ? test : test.skip)("App Store Admin / real PostgreSQL", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        ...process.env, DATABASE_URL: url!, IAP_ADMIN_TEST_CHILD: "1", SKIP_ENV_VALIDATION: "",
        NODE_ENV: "test", BETTER_AUTH_SECRET: "iap-admin-integration-test-secret-only",
        BETTER_AUTH_URL: "http://127.0.0.1:3016", CORS_ORIGIN: "http://127.0.0.1:3017",
        ADMIN_USER_IDS: "", APP_STORE_ENABLED: "false",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
  }, 30_000);
} else {
  describe("App Store Admin persisted boundaries", () => {
    let connection: typeof import("@northwind/db");
    let module: typeof import("./app-store-admin");
    let settings: AppStoreAdminConfiguration;
    const config = () => settings;
    const request = (environment: "Production" | "Sandbox" = "Production") => ({ requestId: crypto.randomUUID(), actorId: "operator", environment });
    const repository = () => module.createAppStoreAdminRepository(connection.db, config);
    beforeAll(async () => {
      connection = await import("@northwind/db");
      module = await import("./app-store-admin");
      await connection.pool.query('CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY)');
      const result = await connection.pool.query("SELECT to_regclass('public.iap_admin_action') AS name");
      if (!result.rows[0].name) {
        const { applyMigrationsFor } = await import("@northwind/db/testing");
        await applyMigrationsFor(connection.pool, [...["iap_account", "iap_notification", "iap_ownership_audit", "iap_subscription", "iap_sync_state"], "iap_admin_action"]);
      }
    });
    beforeEach(async () => {
      await connection.pool.query('TRUNCATE iap_admin_action, iap_notification, iap_subscription, iap_account, iap_ownership_audit, iap_sync_state, "user"');
      await connection.pool.query('INSERT INTO "user" (id) VALUES (\'operator\')');
      settings = {
        ...module.readAppStoreAdminConfiguration({ BETTER_AUTH_URL: "http://127.0.0.1:3016", APP_STORE_ENABLED: false }),
        enabled: true, configured: true, allowedEnvironments: ["Production", "Sandbox"],
      };
    });
    afterAll(async () => { await connection.pool.end(); });

    test("concurrent duplicate requests call Apple once, with durable audit already present", async () => {
      const input = request();
      let calls = 0;
      const service = () => module.createAppStoreAdminService({ configuration: config, repository: repository(),
        requestTestNotification: async () => {
          calls++;
          const audit = await connection.pool.query("SELECT status, actor_id FROM iap_admin_action WHERE request_id=$1", [input.requestId]);
          expect(audit.rows).toEqual([{ status: "pending", actor_id: "operator" }]);
          return "apple-test-token-do-not-store";
        },
      });
      const results = await Promise.all([service().testNotification(input), service().testNotification(input)]);
      expect(calls).toBe(1);
      expect(results.every((result) => result.requestId === input.requestId)).toBe(true);
      expect(await service().testNotification(input)).toMatchObject({ status: "accepted" });
      expect(calls).toBe(1);
      const audit = await connection.pool.query("SELECT * FROM iap_admin_action");
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify(audit.rows)).not.toContain("apple-test-token");
    });

    test("different requests share a database cooldown across instances, independently per environment", async () => {
      const outcomes = await Promise.allSettled([repository().reserve(request()), repository().reserve(request())]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "TOO_MANY_REQUESTS" } });
      expect((await repository().reserve(request("Sandbox"))).isNew).toBe(true);
    });

    test("request IDs cannot be reused for another actor, environment or application", async () => {
      const input = request();
      await repository().reserve(input);
      await expect(repository().reserve({ ...input, actorId: "another-admin" })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(repository().reserve({ ...input, environment: "Sandbox" })).rejects.toMatchObject({ code: "CONFLICT" });
      await connection.pool.query("UPDATE iap_admin_action SET bundle_id='other.app' WHERE request_id=$1", [input.requestId]);
      await expect(repository().reserve(input)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await repository().history()).toEqual([]);
    });

    test("failed audit reservation prevents the external request and rolls back the row", async () => {
      await connection.pool.query("ALTER TABLE iap_admin_action ADD CONSTRAINT iap_admin_fixture_reject CHECK (actor_id <> 'reject-operator')");
      let calls = 0;
      try {
        const service = module.createAppStoreAdminService({ configuration: config, repository: repository(), requestTestNotification: async () => { calls++; } });
        await expect(service.testNotification({ ...request(), actorId: "reject-operator" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        expect(calls).toBe(0);
        expect((await connection.pool.query("SELECT * FROM iap_admin_action")).rowCount).toBe(0);
      } finally { await connection.pool.query("ALTER TABLE iap_admin_action DROP CONSTRAINT iap_admin_fixture_reject"); }
    });

    test("uncertain external outcomes persist and replay without another Apple request", async () => {
      let calls = 0;
      const service = module.createAppStoreAdminService({ configuration: config, repository: repository(),
        requestTestNotification: async () => { calls++; throw new Error("secret external failure body"); },
      });
      const input = request();
      expect(await service.testNotification(input)).toMatchObject({ status: "unknown", errorCode: "APPLE_OUTCOME_UNKNOWN" });
      expect(await service.testNotification(input)).toMatchObject({ status: "unknown" });
      expect(calls).toBe(1);
      expect(JSON.stringify(await repository().history())).not.toContain("secret external");
    });

    test("abandoned requests become unknown, retain their actor after deletion, and can record a late confirmation", async () => {
      const input = request();
      await repository().reserve(input);
      await connection.pool.query("UPDATE iap_admin_action SET created_at=now()-interval '3 minutes' WHERE request_id=$1", [input.requestId]);
      await connection.pool.query('DELETE FROM "user" WHERE id=\'operator\'');
      expect(await repository().history()).toMatchObject([{ actorId: "operator", status: "unknown" }]);
      expect(await repository().reserve(input)).toMatchObject({ isNew: false, action: { status: "unknown" } });
      expect(await repository().finish(input.requestId, { status: "accepted", errorCode: null })).toMatchObject({ status: "accepted" });
    });

    test("diagnostics remain scoped and visible when processing is disabled, and redact notification payloads", async () => {
      settings = { ...settings, enabled: false, allowedEnvironments: ["Production"] };
      for (const [bundle, environment, status, type, code] of [
        [settings.application.bundleId, "Production", "pending", "DID_RENEW", null],
        [settings.application.bundleId, "Sandbox", "dead", "SUBSCRIBED", "private error body"],
        [settings.application.bundleId, "Sandbox", "ignored", "TEST", "TEST"],
        ["other.app", "Production", "pending", "SECRET_OTHER_APP", null],
      ]) await connection.pool.query("INSERT INTO iap_notification (id,bundle_id,environment,notification_uuid,type,status,error_code,signed_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [crypto.randomUUID(), bundle, environment, crypto.randomUUID(), type, status, code, "private-signed-payload"]);
      const service = module.createAppStoreAdminService({ configuration: config, repository: repository(), requestTestNotification: async () => { throw new Error("must not send"); } });
      const overview = await service.overview();
      expect(overview.diagnostics.environments).toMatchObject([
        { environment: "Production", available: true, processingEnabled: false, metrics: { pendingNotifications: 1 } },
        { environment: "Sandbox", available: true, processingEnabled: false, metrics: { deadNotifications: 1 } },
      ]);
      expect(overview.notifications.items).toHaveLength(3);
      expect(overview.notifications.items.find((item) => item.type === "TEST")?.errorCode).toBe("TEST");
      const serialized = JSON.stringify(overview);
      for (const value of ["SECRET_OTHER_APP", "private-signed-payload", "private error body", "notificationUuid", "signedPayload"]) expect(serialized).not.toContain(value);
      await expect(service.testNotification(request())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });

    test("history returns only the twenty most recent requests", async () => {
      await connection.pool.query("INSERT INTO iap_admin_action (request_id,bundle_id,environment,actor_id,status,created_at) SELECT gen_random_uuid(),$1,'Production','operator','accepted',now()-i*interval '1 minute' FROM generate_series(1,25) i", [settings.application.bundleId]);
      const history = await repository().history();
      expect(history).toHaveLength(20);
      expect(history.every((item, index) => index === 0 || item.createdAt <= history[index - 1]!.createdAt)).toBe(true);
    });

    test("cooldown starts after lock acquisition rather than at the beginning of a waiting transaction", async () => {
      const blocker = await connection.pool.connect();
      let pending: ReturnType<ReturnType<typeof repository>["reserve"]> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(812, 2)");
        pending = repository().reserve(request());
        let waiting = false;
        for (let index = 0; index < 50; index++) {
          const locks = await blocker.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
          if (locks.rowCount) { waiting = true; break; }
          await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        const clock = await blocker.query("SELECT clock_timestamp() AS released");
        await blocker.query("COMMIT");
        const reserved = await pending;
        expect(Date.parse(reserved.action.createdAt)).toBeGreaterThanOrEqual(clock.rows[0].released.getTime());
        await expect(repository().reserve(request())).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await pending?.catch(() => undefined);
      }
    });

    test("exact recovery finds an old request beyond the history window while disabled without crossing actor scope", async () => {
      const input = request("Sandbox");
      await repository().reserve(input);
      await connection.pool.query("UPDATE iap_admin_action SET created_at=now()-interval '2 days' WHERE request_id=$1", [input.requestId]);
      await connection.pool.query("INSERT INTO iap_admin_action (request_id,bundle_id,environment,actor_id,status,created_at) SELECT gen_random_uuid(),$1,'Production','operator','accepted',now()-i*interval '1 minute' FROM generate_series(1,25) i", [settings.application.bundleId]);
      settings = { ...settings, enabled: false, configured: false, allowedEnvironments: ["Production"] };
      expect((await repository().history()).some((item) => item.requestId === input.requestId)).toBe(false);
      const service = module.createAppStoreAdminService({ configuration: config, repository: repository(), requestTestNotification: async () => { throw new Error("must not send"); } });
      expect(await service.testRequest(input)).toMatchObject({ requestId: input.requestId, status: "unknown" });
      expect(await service.testRequest({ ...input, actorId: "another-admin" })).toBeNull();
      expect(await service.testRequest({ ...input, environment: "Production" })).toBeNull();
    });
  });
}
