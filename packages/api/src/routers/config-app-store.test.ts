import { describe, expect, test } from "bun:test";
import type { Context } from "../context";
import { createAppStoreConfigRouter } from "./config-app-store";
import { createAppStoreAdminService, readAppStoreAdminConfiguration } from "../app-store-admin";

const context = (role?: string): Context => ({
  auth: null, ip: "test",
  session: role ? { user: { id: "admin-test-operator", role } } as Context["session"] : null,
});
const unavailable = async (): Promise<never> => { throw new Error("private-database-value"); };
const service = createAppStoreAdminService({
  configuration: () => readAppStoreAdminConfiguration({ APP_STORE_ENABLED: false, BETTER_AUTH_URL: "http://localhost:3000" }),
  repository: { metrics: unavailable, notifications: unavailable, history: unavailable, testRequest: unavailable, reserve: unavailable, finish: unavailable },
  requestTestNotification: unavailable,
});
const appStoreRouter = createAppStoreConfigRouter(service);
const input = { environment: "Production" as const, requestId: "4d3898e9-8815-44a9-a8cd-e68da31c4f55" };

describe("Admin App Store routes", () => {
  for (const [role, code] of [[undefined, "UNAUTHORIZED"], ["user", "FORBIDDEN"]] as const) {
    test(`protects diagnostics and Apple test calls for ${role ?? "anonymous"}`, async () => {
      const caller = appStoreRouter.createCaller(context(role));
      await expect(caller.overview()).rejects.toMatchObject({ code });
      await expect(caller.testRequest(input)).rejects.toMatchObject({ code });
      await expect(caller.testNotification(input)).rejects.toMatchObject({ code });
    });
  }

  test("keeps admin diagnostics readable when processing is disabled and storage unavailable", async () => {
    const result = await appStoreRouter.createCaller(context("admin")).overview();
    expect(result.enabled).toBe(false);
    expect(result.diagnostics.environments.every(item => !item.available)).toBe(true);
    expect(result.audit.available).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-database-value");
  });

  test("strictly validates environment, UUID and extra keys before accessing service", async () => {
    const caller = appStoreRouter.createCaller(context("admin"));
    for (const invalid of [
      { ...input, requestId: "not-a-uuid" }, { ...input, environment: "production" },
      { ...input, actorId: "forged-user" }, { ...input, bundleId: "other.app" },
    ]) {
      await expect(caller.testNotification(invalid as typeof input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller.testRequest(invalid as typeof input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  test("disabled deployment prevents test calls", async () => {
    await expect(appStoreRouter.createCaller(context("admin")).testNotification(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  test("exact request queries bind actor identity from the admin session without requiring enabled billing", async () => {
    const calls: unknown[] = [];
    const caller = createAppStoreConfigRouter({
      ...service,
      async testRequest(value) { calls.push(value); return null; },
    }).createCaller(context("admin"));
    expect(await caller.testRequest(input)).toBeNull();
    expect(calls).toEqual([{ ...input, actorId: "admin-test-operator" }]);
  });
});
