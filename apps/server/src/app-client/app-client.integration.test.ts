import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { APP_CLIENT_CONFIG_DEFAULTS, FEEDBACK_LIMITS, type AppClientConfig } from "@northwind/env/app-client-config";
import { mkdir } from "node:fs/promises";

import type { Context } from "@northwind/api/context";
import type { FeedbackScreenshotStorage } from "@northwind/api/feedback-screenshots";

// The failure modes this proves are listed in docs/app-feedback-rating.md §4.
// Never run against DATABASE_URL: the child process points every singleton at
// the dedicated database before anything imports it.
const url = process.env.APP_FEEDBACK_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/northwind_app_feedback_test") {
    throw new Error("APP_FEEDBACK_TEST_DATABASE_URL must reference the dedicated local northwind_app_feedback_test database");
  }
  if (process.env.APP_FEEDBACK_TEST_CHILD === "1" && process.env.DATABASE_URL !== url) {
    throw new Error("The integration child must use APP_FEEDBACK_TEST_DATABASE_URL as DATABASE_URL");
  }
}

if (!url || process.env.APP_FEEDBACK_TEST_CHILD !== "1") {
  (url ? test : test.skip)("app feedback and settings / real PostgreSQL", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        ...process.env,
        DATABASE_URL: url!,
        APP_FEEDBACK_TEST_CHILD: "1",
        SKIP_ENV_VALIDATION: "",
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        BETTER_AUTH_SECRET: "app-feedback-integration-test-secret",
        BETTER_AUTH_URL: "http://localhost:3000",
        CORS_ORIGIN: "http://localhost:3001",
        ADMIN_USER_IDS: "",
        APP_STORE_ENABLED: "false",
        COPILOTKIT_TELEMETRY_DISABLED: "true",
        // Storage is the in-memory stand-in here; never a real bucket from a local .env.
        R2_REGION: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_BUCKET: "", R2_ENDPOINT: "",
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
  }, 60_000);
} else {
  describe("app feedback and settings over HTTP", () => {
    let connection: typeof import("@northwind/db");
    let routes: typeof import("./routes");
    let feedbackStore: typeof import("@northwind/api/app-feedback");
    let configStore: typeof import("@northwind/api/app-client-config");
    let appRouter: typeof import("@northwind/product/router").appRouter;

    /** Every exchange, written out at the end as the run's evidence. */
    const transcript: { test: string; request: string; status: number; body: unknown; retryAfter?: string | null }[] = [];
    let currentTest = "";

    beforeAll(async () => {
      connection = await import("@northwind/db");
      routes = await import("./routes");
      feedbackStore = await import("@northwind/api/app-feedback");
      configStore = await import("@northwind/api/app-client-config");
      appRouter = (await import("@northwind/product/router")).appRouter;
      await connection.pool.query('CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY)');
      const exists = await connection.pool.query("SELECT to_regclass('public.app_feedback_screenshot') AS name");
      if (!exists.rows[0].name) {
        // The reviewed migration statements in order, exactly as a deployment applies them.
        const { applyMigrationsFor } = await import("@northwind/db/testing");
        await applyMigrationsFor(connection.pool, ["app_client_config", "app_client_config_audit", "app_feedback", "app_feedback_attachment", "app_feedback_screenshot"]);
      }
    });
    beforeEach(async () => {
      await connection.pool.query('TRUNCATE app_client_config, app_client_config_audit, app_feedback, app_feedback_screenshot, "user" CASCADE');
    });
    afterAll(async () => {
      const directory = new URL("../../../../.tmp/app-feedback/", import.meta.url);
      await mkdir(directory, { recursive: true });
      await Bun.write(new URL("integration-report.json", directory), `${JSON.stringify({
        contract: "docs/app-feedback-rating.md",
        exchanges: transcript,
      }, null, 2)}\n`);
      await connection.pool.end();
    });

    /** A clock the rate-limit windows and retention read; tests move it. */
    let clock = new Date("2026-09-28T08:00:00Z");
    const store = () => feedbackStore.createAppFeedbackStore(connection.db, () => clock);
    const admin = (id = "operator", role = "admin") => appRouter.createCaller({
      auth: null, ip: "test", session: { user: { id, role } } as Context["session"],
    });

    /**
     * R2 as the real-bucket test (r2-storage.integration.test.ts) shows it
     * behaves: an upload must match the signed type and length, a missing
     * object is `null`, deleting twice is fine. Tests can also plant objects
     * directly, as a client ignoring its link could not but storage might hold.
     */
    class MemoryStorage implements FeedbackScreenshotStorage {
      objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
      signed = new Map<string, { byteLength: number }>();
      failing = false;
      deleted: string[] = [];
      private check() { if (this.failing) throw new Error("R2 unavailable"); }
      async presignUpload(key: string, byteLength: number) {
        this.signed.set(key, { byteLength });
        return { url: `memory://bucket/${key}`, headers: { "Content-Type": "image/jpeg", "Content-Length": String(byteLength) } };
      }
      /** What a client does with its link; refused as R2 refuses it. */
      upload(url: string, bytes: Uint8Array, contentType = "image/jpeg") {
        const key = url.replace("memory://bucket/", "");
        const ticket = this.signed.get(key);
        if (!ticket || ticket.byteLength !== bytes.length || contentType !== "image/jpeg") return 403;
        this.objects.set(key, { bytes, contentType });
        return 200;
      }
      async head(key: string) {
        this.check();
        const object = this.objects.get(key);
        return object ? { size: object.bytes.length, contentType: object.contentType } : null;
      }
      async readPrefix(key: string, count: number) {
        this.check();
        return this.objects.get(key)?.bytes.slice(0, count) ?? null;
      }
      async presignDownload(key: string) { return `memory://bucket/${key}?view`; }
      async delete(key: string) {
        this.check();
        this.objects.delete(key);
        this.deleted.push(key);
      }
    }
    let storage = new MemoryStorage();
    beforeEach(() => { storage = new MemoryStorage(); });

    type Setup = Parameters<typeof routes.createAppClientApp>[0];
    const app = (overrides: Setup = {}) => {
      const feedback = store();
      return routes.createAppClientApp({
        readConfig: configStore.createAppClientConfigStore(connection.db).read,
        submit: feedback.submit,
        reserveScreenshot: feedback.reserveScreenshot,
        claimableScreenshot: feedback.claimableScreenshot,
        storage,
        getUserId: async () => null,
        notify: async () => {},
        ...overrides,
      });
    };

    async function call(target: ReturnType<typeof app>, path: string, init?: RequestInit, label = path) {
      const response = await target.request(path, init);
      const body = await response.json();
      transcript.push({ test: currentTest, request: `${init?.method ?? "GET"} ${label}`, status: response.status, body, retryAfter: response.headers.get("retry-after") });
      return { status: response.status, body, headers: response.headers };
    }

    const installation = () => crypto.randomUUID();
    const valid = (patch: Record<string, unknown> = {}) => ({
      installationId: installation(),
      category: "bug",
      message: "组件没有更新到今天",
      diagnostics: { appVersion: "1.4.0", build: "123", os: "iOS 27.0", device: "iPhone18,1", locale: "zh-Hans", widgetFamilies: ["large"], pro: false, theme: "cinnabar" },
      ...patch,
    });
    const post = (target: ReturnType<typeof app>, body: unknown, ip = "203.0.113.9", label?: string) => call(target, "/api/app/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }, label);
    const reserve = (target: ReturnType<typeof app>, installationId: string, byteLength: number, ip = "203.0.113.9") =>
      call(target, "/api/app/feedback/uploads", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": ip },
        body: JSON.stringify({ installationId, byteLength }),
      });
    /** Reserve, then upload as the app does; returns the upload id. */
    const attach = async (target: ReturnType<typeof app>, installationId: string, bytes: Uint8Array = jpeg(2_048)) => {
      const ticket = await reserve(target, installationId, bytes.length);
      expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
      expect(storage.upload(ticket.body.url, bytes)).toBe(200);
      return ticket.body.uploadId as string;
    };
    const ledger = async () => (await connection.pool.query(
      "SELECT id, object_key, feedback_id, attached_at FROM app_feedback_screenshot ORDER BY created_at")).rows;
    const jpeg = (bytes: number) => {
      const data = Buffer.alloc(bytes, 0x11);
      data.set([0xff, 0xd8, 0xff, 0xe0]);
      return data;
    };
    const saveConfig = async (edit: (values: AppClientConfig) => void) => {
      const caller = admin();
      const current = await caller.config.appClient.overview();
      const values = structuredClone(current.values);
      edit(values);
      return caller.config.appClient.update({ expectedRevision: current.revision, values });
    };
    const rows = async () => (await connection.pool.query("SELECT count(*)::int AS n FROM app_feedback")).rows[0].n as number;

    beforeEach(() => { clock = new Date("2026-09-28T08:00:00Z"); });

    test("with nothing saved the app reads the shared defaults, cacheable", async () => {
      currentTest = "defaults";
      const response = await call(app(), "/api/app/config");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      expect(response.body).toEqual({ revision: 0, ...APP_CLIENT_CONFIG_DEFAULTS });
    });

    test("an administrator's change is audited and is what the app reads next", async () => {
      currentTest = "config update";
      const saved = await saveConfig((values) => { values.review.cooldownDays = 90; values.feedback.allowsScreenshot = false; });
      expect(saved).toMatchObject({ revision: 1, source: "database", updatedBy: "operator" });
      const response = await call(app(), "/api/app/config");
      expect(response.body).toMatchObject({ revision: 1, review: { cooldownDays: 90 }, feedback: { allowsScreenshot: false } });
      const history = await admin().config.appClient.history();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ revision: 1, actorId: "operator", before: APP_CLIENT_CONFIG_DEFAULTS });
      expect(history[0]!.after.review.cooldownDays).toBe(90);
    });

    test("two administrators saving at once: one wins, the other is told to reload", async () => {
      currentTest = "config conflict";
      const caller = admin();
      const values = (days: number) => ({ ...APP_CLIENT_CONFIG_DEFAULTS, review: { ...APP_CLIENT_CONFIG_DEFAULTS.review, cooldownDays: days } });
      const results = await Promise.allSettled([
        caller.config.appClient.update({ expectedRevision: 0, values: values(30) }),
        caller.config.appClient.update({ expectedRevision: 0, values: values(40) }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
      expect(await caller.config.appClient.history()).toHaveLength(1);
    });

    test("settings out of range never reach the database", async () => {
      currentTest = "config bounds";
      const caller = admin();
      await expect(caller.config.appClient.update({
        expectedRevision: 0,
        values: { ...APP_CLIENT_CONFIG_DEFAULTS, review: { ...APP_CLIENT_CONFIG_DEFAULTS.review, cooldownDays: 0 } },
      })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller.config.appClient.update({
        expectedRevision: 0,
        values: { ...APP_CLIENT_CONFIG_DEFAULTS, feedback: { ...APP_CLIENT_CONFIG_DEFAULTS.feedback, categories: [] } },
      })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect((await caller.config.appClient.overview()).revision).toBe(0);
    });

    test("only administrators can read settings or feedback", async () => {
      currentTest = "admin only";
      const anonymous = appRouter.createCaller({ auth: null, ip: "test", session: null });
      await expect(anonymous.appFeedback.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(anonymous.config.appClient.overview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(admin("reader", "user").appFeedback.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(admin("reader", "user").config.appClient.update({ expectedRevision: 0, values: APP_CLIENT_CONFIG_DEFAULTS }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    test("a valid submission is saved, then the operator is told once", async () => {
      currentTest = "submit";
      const notified: string[] = [];
      const target = app({ notify: async (feedback) => { notified.push(feedback.id); } });
      const response = await post(target, valid({ contact: "reader@example.com", context: "widgetNotUpdating" }));
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ id: expect.any(String) });
      expect(notified).toEqual([response.body.id]);
      const detail = await admin().appFeedback.detail({ id: response.body.id });
      expect(detail).toMatchObject({
        category: "bug", message: "组件没有更新到今天", contact: "reader@example.com", context: "widgetNotUpdating",
        signedIn: false, status: "new", screenshotUrl: null, screenshotStored: false, screenshotExpired: false,
        diagnostics: { appVersion: "1.4.0", widgetFamilies: ["large"], pro: false },
      });
    });

    test("a failing notification never fails or repeats the save", async () => {
      currentTest = "notify failure";
      const response = await post(app({ notify: async () => { throw new Error("mail down"); } }), valid());
      expect(response.status).toBe(201);
      await Bun.sleep(10);
      expect(await rows()).toBe(1);
    });

    test("who sent it comes from the session only, never the body", async () => {
      currentTest = "identity";
      await connection.pool.query(`INSERT INTO "user" (id) VALUES ('reader-1')`);
      expect((await post(app(), valid({ userId: "someone-else" }))).body).toEqual({ error: "invalid_feedback", field: "body" });
      const signedIn = await post(app({ getUserId: async () => "reader-1" }), valid());
      const anonymous = await post(app(), valid());
      expect((await admin().appFeedback.detail({ id: signedIn.body.id })).signedIn).toBe(true);
      expect((await admin().appFeedback.detail({ id: anonymous.body.id })).signedIn).toBe(false);
      // A deleted account takes its feedback with it.
      await connection.pool.query(`DELETE FROM "user" WHERE id = 'reader-1'`);
      await expect(admin().appFeedback.detail({ id: signedIn.body.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await rows()).toBe(1);
    });

    test("the raw address is never stored, only a keyed digest", async () => {
      currentTest = "ip digest";
      await post(app(), valid(), "198.51.100.23");
      const { rows: saved } = await connection.pool.query("SELECT ip_hash FROM app_feedback");
      expect(saved[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(saved[0].ip_hash).not.toContain("198.51.100.23");
      const { rows: text } = await connection.pool.query("SELECT count(*)::int AS n FROM app_feedback WHERE row_to_json(app_feedback)::text LIKE '%198.51.100.23%'");
      expect(text[0].n).toBe(0);
    });

    test("malformed submissions name the field and save nothing", async () => {
      currentTest = "invalid";
      const target = app();
      const cases: [unknown, string][] = [
        ["{not json", "body"],
        [valid({ installationId: "not-a-uuid" }), "installationId"],
        [valid({ category: "praise" }), "category"],
        [valid({ message: "   " }), "message"],
        [valid({ message: "字".repeat(APP_CLIENT_CONFIG_DEFAULTS.feedback.maxMessageLength + 1) }), "message"],
        [valid({ contact: "x".repeat(FEEDBACK_LIMITS.contactLength + 1) }), "contact"],
        [valid({ context: "somewhereElse" }), "context"],
        [valid({ diagnostics: { appVersion: "1.4.0", advertisingId: "abc" } }), "diagnostics"],
        [valid({ screenshotUploadId: "not-a-uuid" }), "screenshotUploadId"],
        // Image bytes in the body are no longer a field at all.
        [valid({ screenshot: Buffer.from(jpeg(64)).toString("base64") }), "body"],
      ];
      for (const [body, field] of cases) {
        const response = await post(target, body, undefined, `/api/app/feedback (${field})`);
        expect(response.status, JSON.stringify(response.body)).toBe(400);
        expect(response.body).toEqual({ error: "invalid_feedback", field });
      }
      const oversized = await post(target, JSON.stringify(valid({ message: "A".repeat(FEEDBACK_LIMITS.requestBytes) })), undefined, "/api/app/feedback (oversized)");
      expect(oversized.body).toEqual({ error: "invalid_feedback", field: "body" });
      expect(await rows()).toBe(0);
    });

    test("the form follows the saved settings: switched off, fewer categories, no screenshots", async () => {
      currentTest = "settings apply";
      await saveConfig((values) => { values.feedback.categories = ["bug", "suggestion"]; values.feedback.allowsScreenshot = false; values.feedback.maxMessageLength = 50; });
      const target = app();
      expect((await post(target, valid({ category: "other" }))).body).toEqual({ error: "invalid_feedback", field: "category" });
      expect((await reserve(target, installation(), 100)).body).toEqual({ error: "screenshots_disabled" });
      expect((await post(target, valid({ screenshotUploadId: crypto.randomUUID() }))).body).toEqual({ error: "invalid_feedback", field: "screenshotUploadId" });
      expect((await post(target, valid({ message: "字".repeat(51) }))).body).toEqual({ error: "invalid_feedback", field: "message" });
      await saveConfig((values) => { values.feedback.enabled = false; });
      const disabled = await post(target, valid());
      expect(disabled.status).toBe(403);
      expect(disabled.body).toEqual({ error: "feedback_disabled" });
      expect(await rows()).toBe(0);
    });

    test("without R2 there are no screenshots: the app is told, uploads are refused", async () => {
      currentTest = "no storage";
      const target = app({ storage: null });
      expect((await call(target, "/api/app/config")).body.feedback.allowsScreenshot).toBe(false);
      expect((await reserve(target, installation(), 100)).body).toEqual({ error: "screenshots_disabled" });
      expect((await post(target, valid({ screenshotUploadId: crypto.randomUUID() }))).body)
        .toEqual({ error: "invalid_feedback", field: "screenshotUploadId" });
      expect((await call(app(), "/api/app/config")).body.feedback.allowsScreenshot).toBe(true);
      expect(await rows()).toBe(0);
    });

    test("a screenshot goes straight to storage, is attached once, and shown by a signed link", async () => {
      currentTest = "screenshot";
      const target = app();
      const id = installation();
      const ticket = await reserve(target, id, 2_048);
      expect(ticket.status).toBe(201);
      expect(ticket.body).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/jpeg", "Content-Length": "2048" } });
      expect(new Date(ticket.body.expiresAt).getTime() - clock.getTime()).toBe(600_000);
      // The link takes only what was signed.
      expect(storage.upload(ticket.body.url, jpeg(4_096))).toBe(403);
      expect(storage.upload(ticket.body.url, jpeg(2_048), "image/png")).toBe(403);
      expect(storage.upload(ticket.body.url, jpeg(2_048))).toBe(200);

      const saved = await post(target, valid({ installationId: id, screenshotUploadId: ticket.body.uploadId }));
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      const [row] = await ledger();
      expect(row).toMatchObject({ id: ticket.body.uploadId, feedback_id: saved.body.id });
      expect(row.object_key).toMatch(/^app-feedback\/test\/2026-09\/[0-9a-f-]{36}\.jpg$/);
      expect((await admin().appFeedback.list({})).items[0]).toMatchObject({ hasScreenshot: true });
      // This server has no R2 of its own: the admin sees that one is stored, not a link.
      expect(await admin().appFeedback.detail({ id: saved.body.id }))
        .toMatchObject({ screenshotUrl: null, screenshotStored: true, screenshotExpired: false });
      expect(JSON.stringify(await admin().appFeedback.detail({ id: saved.body.id }))).not.toContain(row.object_key);

      // One upload, one piece of feedback.
      expect((await post(target, valid({ installationId: id, screenshotUploadId: ticket.body.uploadId }))).body)
        .toEqual({ error: "invalid_feedback", field: "screenshotUploadId" });
    });

    test("an upload is attached only if storage holds exactly what was reserved", async () => {
      currentTest = "screenshot checks";
      const target = app();
      const id = installation();
      const bad = async (label: string, uploadId: string, installationId = id) => {
        const response = await post(target, valid({ installationId, screenshotUploadId: uploadId }), undefined, `/api/app/feedback (${label})`);
        expect(response.body, label).toEqual({ error: "invalid_feedback", field: "screenshotUploadId" });
      };
      await bad("never reserved", crypto.randomUUID());
      const notUploaded = await reserve(target, id, 2_048);
      await bad("reserved, not uploaded", notUploaded.body.uploadId);
      const planted = async (bytes: Uint8Array, reserved = bytes.length) => {
        const ticket = await reserve(target, id, reserved);
        const key = (await ledger()).find((entry) => entry.id === ticket.body.uploadId)!.object_key;
        storage.objects.set(key, { bytes, contentType: "image/jpeg" });
        return ticket.body.uploadId as string;
      };
      await bad("different size", await planted(jpeg(3_000), 2_048));
      await bad("not a JPEG", await planted(new TextEncoder().encode("GIF89a, not a jpeg at all")));
      await bad("someone else's", await attach(target, id), installation());
      const late = await attach(target, id);
      clock = new Date(clock.getTime() + 3_600_001);
      await bad("claimed after an hour", late);
      clock = new Date(clock.getTime() - 3_600_001);

      storage.failing = true;
      const unavailable = await post(target, valid({ installationId: id, screenshotUploadId: await (async () => {
        storage.failing = false;
        const uploadId = await attach(target, id);
        storage.failing = true;
        return uploadId;
      })() }));
      expect(unavailable).toMatchObject({ status: 503, body: { error: "unavailable" } });
      storage.failing = false;
      expect(await rows()).toBe(0);
      expect((await ledger()).every((entry) => entry.feedback_id === null)).toBe(true);
    });

    test("two sends racing for one upload: exactly one gets it", async () => {
      currentTest = "claim race";
      const target = app();
      const id = installation();
      const uploadId = await attach(target, id);
      const results = await Promise.all([1, 2].map(() => post(target, valid({ installationId: id, screenshotUploadId: uploadId }))));
      expect(results.map((result) => result.status).sort()).toEqual([201, 400]);
      expect(await rows()).toBe(1);
    });

    test("uploads are limited per installation and per address", async () => {
      currentTest = "upload limits";
      const target = app();
      const id = installation();
      for (let index = 0; index < FEEDBACK_LIMITS.uploadsPerHour; index += 1) {
        expect((await reserve(target, id, 100)).status).toBe(201);
      }
      const limited = await reserve(target, id, 100);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("3600");
      for (let index = FEEDBACK_LIMITS.uploadsPerHour; index < FEEDBACK_LIMITS.ipUploadsPerHour; index += 1) {
        expect((await reserve(target, installation(), 100)).status).toBe(201);
      }
      expect((await reserve(target, installation(), 100)).status).toBe(429);
      expect((await reserve(target, installation(), 100, "192.0.2.77")).status).toBe(201);
      for (const [byteLength, field] of [[0, "byteLength"], [FEEDBACK_LIMITS.screenshotBytes + 1, "byteLength"], [1.5, "byteLength"]] as const) {
        expect((await reserve(target, installation(), byteLength)).body).toEqual({ error: "invalid_upload", field });
      }
    });

    test("clean-up deletes objects through the ledger: unsent, expired, and orphaned by account deletion", async () => {
      currentTest = "purge";
      const target = app();
      await connection.pool.query(`INSERT INTO "user" (id) VALUES ('reader-2')`);
      const unsent = await attach(target, installation());
      const keptId = installation();
      const kept = await post(target, valid({ installationId: keptId, screenshotUploadId: await attach(target, keptId) }));
      const deletedId = installation();
      const signedIn = await post(app({ getUserId: async () => "reader-2" }),
        valid({ installationId: deletedId, screenshotUploadId: await attach(target, deletedId) }));
      expect([kept.status, signedIn.status]).toEqual([201, 201]);
      const key = async (uploadOrFeedback: string) => (await ledger())
        .find((entry) => entry.id === uploadOrFeedback || entry.feedback_id === uploadOrFeedback)?.object_key;
      const keys = { unsent: await key(unsent), kept: await key(kept.body.id), deleted: await key(signedIn.body.id) };
      expect(Object.values(keys).every((objectKey) => objectKey && storage.objects.has(objectKey))).toBe(true);

      // Nothing is due yet.
      expect(await store().purgeScreenshots(storage)).toEqual({ deleted: 0, failed: 0 });
      // Deleting the account removes the feedback; its screenshot goes at the next clean-up.
      await connection.pool.query(`DELETE FROM "user" WHERE id = 'reader-2'`);
      expect(await store().purgeScreenshots(storage)).toEqual({ deleted: 1, failed: 0 });
      expect(storage.objects.has(keys.deleted!)).toBe(false);
      // An upload never sent goes after a day.
      clock = new Date(clock.getTime() + 25 * 3_600_000);
      expect(await store().purgeScreenshots(storage)).toEqual({ deleted: 1, failed: 0 });
      expect(storage.objects.has(keys.unsent!)).toBe(false);
      // A failed deletion keeps its row for next time.
      clock = new Date(clock.getTime() + 180 * 86_400_000);
      storage.failing = true;
      expect(await store().purgeScreenshots(storage)).toEqual({ deleted: 0, failed: 1 });
      storage.failing = false;
      expect(await store().purgeScreenshots(storage)).toEqual({ deleted: 1, failed: 0 });
      expect(storage.objects.size).toBe(0);
      expect(await ledger()).toEqual([]);
      expect(await admin().appFeedback.detail({ id: kept.body.id }))
        .toMatchObject({ screenshotStored: false, screenshotExpired: true, message: "组件没有更新到今天" });
      // No storage configured: nothing can be deleted, so nothing is claimed to be.
      expect(await store().purgeScreenshots(null)).toEqual({ deleted: 0, failed: 0 });
    });

    test("one installation: five an hour, then told when to come back", async () => {
      currentTest = "installation limit";
      const target = app();
      const id = installation();
      for (let index = 0; index < FEEDBACK_LIMITS.perHour; index += 1) {
        clock = new Date(clock.getTime() + 60_000);
        expect((await post(target, valid({ installationId: id }))).status).toBe(201);
      }
      const limited = await post(target, valid({ installationId: id }));
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: "rate_limited" });
      // The first of the five was 4 minutes ago: free again in 56 minutes.
      expect(limited.headers.get("retry-after")).toBe(String(56 * 60));
      expect((await post(target, valid())).status).toBe(201);
      clock = new Date(clock.getTime() + 56 * 60_000 + 1_000);
      expect((await post(target, valid({ installationId: id }))).status).toBe(201);
    });

    test("one installation: twenty a day across hours", async () => {
      currentTest = "daily limit";
      const target = app();
      const id = installation();
      for (let index = 0; index < FEEDBACK_LIMITS.perDay; index += 1) {
        if (index % FEEDBACK_LIMITS.perHour === 0) clock = new Date(clock.getTime() + 3_600_001);
        expect((await post(target, valid({ installationId: id }), `198.51.100.${index}`)).status).toBe(201);
      }
      clock = new Date(clock.getTime() + 3_600_001);
      expect((await post(target, valid({ installationId: id }), "198.51.100.200")).status).toBe(429);
    });

    test("one address shared by many installations: twenty an hour", async () => {
      currentTest = "address limit";
      const target = app();
      for (let index = 0; index < FEEDBACK_LIMITS.ipPerHour; index += 1) {
        expect((await post(target, valid(), "192.0.2.1")).status).toBe(201);
      }
      expect((await post(target, valid(), "192.0.2.1")).status).toBe(429);
      expect((await post(target, valid(), "192.0.2.2")).status).toBe(201);
    });

    test("simultaneous submissions cannot slip past the limit", async () => {
      currentTest = "concurrent limit";
      const target = app();
      const id = installation();
      const results = await Promise.all(Array.from({ length: 12 }, () => post(target, valid({ installationId: id }))));
      expect(results.filter((result) => result.status === 201)).toHaveLength(FEEDBACK_LIMITS.perHour);
      expect(results.filter((result) => result.status === 429)).toHaveLength(12 - FEEDBACK_LIMITS.perHour);
      expect(await rows()).toBe(FEEDBACK_LIMITS.perHour);
    });

    test("an unreadable database is 503, never an answer that switches the app off", async () => {
      currentTest = "unavailable";
      const broken = app({
        readConfig: async () => { throw new Error("connection refused"); },
      });
      const config = await call(broken, "/api/app/config");
      expect(config.status).toBe(503);
      expect(config.headers.get("cache-control")).toBe("no-store");
      expect(config.body).toEqual({ error: "unavailable" });
      expect((await post(broken, valid())).status).toBe(503);
      const failingSave = await post(app({ submit: async () => { throw new Error("connection refused"); } }), valid());
      expect(failingSave).toMatchObject({ status: 503, body: { error: "unavailable" } });
    });

    test("administrators page through feedback and mark it handled", async () => {
      currentTest = "admin triage";
      const target = app();
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        clock = new Date(clock.getTime() + 1_000);
        ids.push((await post(target, valid({ message: `第 ${index + 1} 条` }), `192.0.2.${index}`)).body.id);
      }
      // Exactly what the admin page's infinite query sends for its first page.
      const first = await admin().appFeedback.list({ limit: 2, cursor: null, direction: "forward" });
      expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
      const second = await admin().appFeedback.list({ limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
      expect(second.nextCursor).toBeNull();

      expect(await admin().appFeedback.setStatus({ id: ids[0]!, status: "done" })).toEqual({ id: ids[0], status: "done" });
      expect((await admin().appFeedback.list({ status: "new" })).items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
      expect((await admin().appFeedback.list({ status: "done" })).items.map((item) => item.id)).toEqual([ids[0]]);
      expect((await admin().appFeedback.detail({ id: ids[0]! })).handledAt).not.toBeNull();
      await admin().appFeedback.setStatus({ id: ids[0]!, status: "new" });
      expect((await admin().appFeedback.detail({ id: ids[0]! })).handledAt).toBeNull();
      await expect(admin().appFeedback.setStatus({ id: crypto.randomUUID(), status: "done" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
}
