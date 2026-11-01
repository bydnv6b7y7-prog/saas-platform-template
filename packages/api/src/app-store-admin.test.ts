import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { APPLE_APPLICATION } from "@northwind/env/apple-application";
import {
  createAppStoreAdminService, readAppStoreAdminConfiguration,
  type AppStoreAdminAction, type AppStoreAdminRepository,
} from "./app-store-admin";

const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const configured = {
  BETTER_AUTH_URL: "https://billing.example.com/nested",
  APP_STORE_ISSUER_ID: "secret-issuer-value", APP_STORE_KEY_ID: "secret-key-id",
  APP_STORE_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString("base64"),
  APP_STORE_ENVIRONMENTS: "Production,Sandbox", APP_STORE_ENABLED: true,
};
const metrics = {
  pendingNotifications: 1, oldestNotificationAgeSeconds: 12, deadNotifications: 2,
  pendingTokens: 3, blockedTokens: 4, staleSubscriptions: 5, historyCoverageGaps: 6,
  unfinishedHistoryScopes: 7, historyLagSeconds: 8,
};
const request = { requestId: "f7bfda7d-4b3d-44c1-9c76-c75c409bdc7b", environment: "Sandbox" as const, actorId: "admin-a" };
const pending: AppStoreAdminAction = { ...request, status: "pending", errorCode: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" };

function setup(options: {
  values?: Record<string, unknown>;
  overrides?: Partial<AppStoreAdminRepository>;
  send?: () => Promise<unknown>;
} = {}) {
  const events: string[] = [];
  const records = new Map<string, AppStoreAdminAction>();
  const repository: AppStoreAdminRepository = {
    async metrics(environment) { events.push(`metrics:${environment}`); return metrics; },
    async notifications() { return []; },
    async history() { return [...records.values()]; },
    async testRequest(input) { return records.get(input.requestId) ?? null; },
    async reserve(input) {
      events.push("reserve");
      const existing = records.get(input.requestId);
      if (existing) return { action: existing, isNew: false };
      const action = { ...pending, ...input };
      records.set(input.requestId, action);
      return { action, isNew: true };
    },
    async finish(id, outcome) {
      events.push("finish");
      const action = { ...records.get(id)!, ...outcome };
      records.set(id, action);
      return action;
    },
    ...options.overrides,
  };
  const service = createAppStoreAdminService({
    configuration: () => readAppStoreAdminConfiguration(options.values ?? configured), repository,
    async requestTestNotification() { events.push("apple"); return options.send ? options.send() : "secret-apple-notification-token"; },
  });
  return { service, events, records };
}

describe("App Store Admin metadata", () => {
  test("returns one catalog and redacts all credentials and URL credentials", () => {
    const result = readAppStoreAdminConfiguration({ ...configured, BETTER_AUTH_URL: "https://name:secret-url@billing.example.com/path" });
    expect(result.configured).toBe(true);
    expect(result.application).toBe(APPLE_APPLICATION);
    expect(result.notificationUrl).toBe("https://billing.example.com/api/auth/app-store/notifications");
    expect(result.credentials.every(item => item.present)).toBe(true);
    const serialized = JSON.stringify(result);
    for (const value of ["secret-issuer-value", "secret-key-id", configured.APP_STORE_PRIVATE_KEY_BASE64, "secret-url"]) expect(serialized).not.toContain(value);
  });

  test("reports valid credentials independently of the processing switch", () => {
    expect(readAppStoreAdminConfiguration({ ...configured, APP_STORE_ENABLED: false })).toMatchObject({ enabled: false, configured: true });
    expect(readAppStoreAdminConfiguration({ ...configured, APP_STORE_ENABLED: "false", APP_STORE_KEY_ID: undefined }))
      .toMatchObject({ enabled: false, configured: false, configurationError: null });
  });

  test("rejects malformed private keys and conflicting catalog assertions without exposing values", () => {
    for (const override of [{ APP_STORE_PRIVATE_KEY_BASE64: "secret-invalid-pem" }, { APP_STORE_BUNDLE_ID: "secret-other-app" }, { APP_STORE_ENVIRONMENTS: "Production," }, { APP_STORE_RECONCILE_INTERVAL_SECONDS: 0 }]) {
      const result = readAppStoreAdminConfiguration({ ...configured, ...override });
      expect(result.configured).toBe(false);
      expect(result.configurationError).toBe("INVALID_CONFIGURATION");
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  test("inspects persisted metrics from disabled environments without presenting active processing", async () => {
    const { service, events } = setup({ values: { ...configured, APP_STORE_ENVIRONMENTS: "Production" } });
    const result = await service.overview();
    expect(events).toEqual(["metrics:Production", "metrics:Sandbox"]);
    expect(result.diagnostics.environments[0]).toMatchObject({ environment: "Production", processingEnabled: true, available: true, metrics });
    expect(result.diagnostics.environments[1]).toMatchObject({ environment: "Sandbox", processingEnabled: false, available: true, metrics });
  });

  test("keeps unavailable diagnostics separate from zero and exposes no storage errors", async () => {
    const unavailable = async () => { throw new Error("private-database-secret"); };
    const { service } = setup({ overrides: { metrics: unavailable, history: unavailable, notifications: unavailable } });
    const result = await service.overview();
    expect(result.diagnostics.environments.every(item => !item.available && item.metrics === null)).toBe(true);
    expect(result.notifications).toEqual({ available: false, items: [] });
    expect(result.audit).toEqual({ available: false, items: [] });
    expect(JSON.stringify(result)).not.toContain("private-database-secret");
  });
});

describe("App Store Admin test requests", () => {
  test("exact recorded status stays readable after processing is disabled without contacting Apple", async () => {
    const { service, records, events } = setup({ values: { APP_STORE_ENABLED: false } });
    records.set(request.requestId, pending);
    expect(await service.testRequest(request)).toEqual(pending);
    expect(events).toEqual([]);
  });

  test("missing exact requests return null, while storage failures remain explicit and redacted", async () => {
    const { service, events } = setup();
    expect(await service.testRequest(request)).toBeNull();
    expect(events).toEqual([]);
    const { service: unavailable } = setup({ overrides: { async testRequest() { throw new Error("private storage error"); } } });
    await expect(unavailable.testRequest(request)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR", message: "Test request audit is unavailable. Try checking this request again later.",
    });
  });

  test("persists reservation before contacting Apple; acceptance is not delivery", async () => {
    const { service, events } = setup();
    const result = await service.testNotification(request);
    expect(events).toEqual(["reserve", "apple", "finish"]);
    expect(result.status).toBe("accepted");
    expect(Object.keys(result)).toEqual(Object.keys(pending));
    expect(JSON.stringify(result)).not.toContain("secret-apple-notification-token");
  });

  test("rejects disabled, unconfigured and disallowed actions before reservation or Apple calls", async () => {
    for (const override of [{ APP_STORE_ENABLED: false }, { APP_STORE_KEY_ID: undefined }, { APP_STORE_ENVIRONMENTS: "Production" }]) {
      const { service, events } = setup({ values: { ...configured, ...override } });
      await expect(service.testNotification(request)).rejects.toMatchObject({ code: override.APP_STORE_ENVIRONMENTS ? "BAD_REQUEST" : "PRECONDITION_FAILED" });
      expect(events).toEqual([]);
    }
  });

  test("storage reservation failure prevents any Apple side effect", async () => {
    const { service, events } = setup({ overrides: { async reserve() { throw new Error("connection secret"); } } });
    await expect(service.testNotification(request)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "Test request audit is unavailable. This attempt made no new call to Apple; check this request again later." });
    expect(events).toEqual([]);
  });

  test("same request ID is idempotent, including concurrent calls while Apple is pending", async () => {
    let finishApple!: () => void;
    const { service, events } = setup({ send: () => new Promise(resolve => { finishApple = () => resolve("token"); }) });
    const first = service.testNotification(request);
    await Promise.resolve();
    const second = await service.testNotification(request);
    expect(second.status).toBe("pending");
    finishApple();
    expect((await first).status).toBe("accepted");
    expect((await service.testNotification(request)).status).toBe("accepted");
    expect(events.filter(event => event === "apple")).toHaveLength(1);
  });

  test("transport uncertainty persists unknown; same request never retries Apple", async () => {
    const { service, events } = setup({ send: async () => { throw new Error("secret signedPayload timeout"); } });
    const result = await service.testNotification(request);
    expect(result).toMatchObject({ status: "unknown", errorCode: "APPLE_OUTCOME_UNKNOWN" });
    expect(await service.testNotification(request)).toEqual(result);
    expect(events.filter(event => event === "apple")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("signedPayload");
  });

  test("distinguishes explicit Apple rejection from ambiguous failure without storing raw errors", async () => {
    for (const appleHttpStatus of [400, 401, 403, 429, 408, 500]) {
      const { service } = setup({ send: async () => { throw { appleHttpStatus, message: "sensitive-Apple-content", cause: "private" }; } });
      const result = await service.testNotification(request);
      const explicitRejection = appleHttpStatus < 500 && appleHttpStatus !== 408;
      expect(result.status).toBe(explicitRejection ? "failed" : "unknown");
      expect(JSON.stringify(result)).not.toContain("sensitive");
    }
  });

  test("failure to persist the Apple outcome never claims completion", async () => {
    const { service, records, events } = setup({ overrides: { async finish() { throw new Error("sensitive DB error"); } } });
    await expect(service.testNotification(request)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "The test request outcome could not be saved. Reload its audit status; do not start a new request." });
    expect(records.get(request.requestId)?.status).toBe("pending");
    expect((await service.testNotification(request)).status).toBe("pending");
    expect(events.filter(event => event === "apple")).toHaveLength(1);
  });
});
