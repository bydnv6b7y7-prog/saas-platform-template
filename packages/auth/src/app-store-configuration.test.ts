import { expect, test } from "bun:test";
import { APPLE_APPLICATION } from "@northwind/env/apple-application";
import { APP_STORE_MAINTENANCE_DEFAULTS, appStoreServerSchema } from "@northwind/env/app-store";
import { z } from "zod";
import { resolveAppStoreConfiguration } from "./app-store-configuration";

const enabled = {
  APP_STORE_ENABLED: true,
  APP_STORE_ISSUER_ID: "fixture",
  APP_STORE_KEY_ID: "fixture",
  APP_STORE_PRIVATE_KEY_BASE64: "Zml4dHVyZQ==",
};

test("the three credentials are sufficient and all billing scope derives from the shared application", () => {
  const configuration = resolveAppStoreConfiguration(enabled)!;
  expect(configuration.apple.bundleId).toBe(APPLE_APPLICATION.bundleId);
  expect(configuration.apple.appAppleId).toBe(APPLE_APPLICATION.appAppleId);
  expect(configuration.environments).toEqual(["Production"]);
  expect(configuration.products).toEqual(APPLE_APPLICATION.products.map(({ productId, entitlement }) => ({
    productId, entitlement, subscriptionGroupId: APPLE_APPLICATION.subscriptionGroupId,
  })));
  expect(configuration.reverifyIntervalMs).toBe(APP_STORE_MAINTENANCE_DEFAULTS.reverifyIntervalSeconds * 1000);
  expect(configuration.reconcileIntervalMs).toBe(APP_STORE_MAINTENANCE_DEFAULTS.reconcileIntervalSeconds * 1000);
});

test("App Store stays enabled by default and missing credentials fail closed", () => {
  expect(z.object(appStoreServerSchema).parse({}).APP_STORE_ENABLED).toBe(true);
  expect(resolveAppStoreConfiguration({ ...enabled, APP_STORE_ENABLED: undefined })).toEqual(resolveAppStoreConfiguration(enabled));
  expect(() => resolveAppStoreConfiguration({})).toThrow("App Store configuration missing: APP_STORE_ISSUER_ID, APP_STORE_KEY_ID, APP_STORE_PRIVATE_KEY_BASE64");
  expect(() => resolveAppStoreConfiguration({ APP_STORE_ENABLED: true })).toThrow("APP_STORE_ISSUER_ID");
});

test("the explicit false emergency switch disables without requiring Apple credentials", () => {
  const disabled = z.object(appStoreServerSchema).parse({ APP_STORE_ENABLED: "false" });
  expect(disabled.APP_STORE_ENABLED).toBe(false);
  expect(resolveAppStoreConfiguration(disabled)).toBeNull();
  expect(resolveAppStoreConfiguration({ ...enabled, APP_STORE_ENABLED: false })).toBeNull();
  for (const invalid of ["0", "yes", "FALSE"]) {
    expect(() => z.object(appStoreServerSchema).parse({ APP_STORE_ENABLED: invalid })).toThrow();
  }
});

test("environment and maintenance controls remain explicit deployment overrides", () => {
  expect(resolveAppStoreConfiguration({
    ...enabled, APP_STORE_ENVIRONMENTS: " Sandbox, Production, Sandbox ",
    APP_STORE_REVERIFY_INTERVAL_SECONDS: 300, APP_STORE_RECONCILE_INTERVAL_SECONDS: 86400,
  })).toMatchObject({ environments: ["Sandbox", "Production"], reverifyIntervalMs: 300000, reconcileIntervalMs: 86400000 });
  for (const overrides of [
    { APP_STORE_ISSUER_ID: "" },
    { APP_STORE_ENVIRONMENTS: "Xcode" },
    { APP_STORE_ENVIRONMENTS: "Production," },
    { APP_STORE_REVERIFY_INTERVAL_SECONDS: 299 },
    { APP_STORE_RECONCILE_INTERVAL_SECONDS: 0 },
  ]) expect(() => resolveAppStoreConfiguration({ ...enabled, ...overrides })).toThrow();
});
